/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, type ObservableValue, SystemClock } from '@hydranium/protocol';
import { makeFakeClock } from '@hydranium/protocol/testing';
import { describe, expect, it } from 'vitest';
import { type DidChangeWatchedFilesParams, Emitter, FileChangeType, type TextDocumentChangeEvent } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from '@hydranium/langium';
import type { ServerSharedServices } from '../../src/langium/module.js';
import { HydraniumDocumentUpdateHandler } from '../../src/lsp/hydranium-document-update-handler.js';
import { LANGUAGE_CLIENT_ID } from '../../src/documents/client-ids.js';
import { makeNoopTracer } from '../../src/testing/index.js';

interface DispatchCall {
   changed: URI[];
   deleted: URI[];
}

/**
 * A watched file the tests reason about. Nothing is ever read from disk — the
 * `mtimeMs` seam is stubbed — so the path only has to be shaped like one.
 */
const WATCHED_URI = URI.file('/hydranium-test/changed.a').toString();
/** `fsPath` as the handler derives it, so assertions stay platform-neutral. */
const WATCHED_FS_PATH = URI.parse(WATCHED_URI).fsPath;

/** Arbitrary fixed mtime the stubbed `FileSystemProvider` reports by default. */
const STUB_MTIME_MS = 1_700_000_000_000;

/**
 * Flush the `dispatch` promise chain (`workspaceManager.ready.then`, and
 * `filterSelfSaves`' `Promise.all` on the `mtimeMs` seam). Five iterations
 * clears the deepest chain in this file with room to spare; because every stub
 * resolves immediately there is no I/O to wait on, so this is deterministic
 * rather than a timing guess.
 */
async function flushMicrotasks(): Promise<void> {
   for (let i = 0; i < 5; i++) {
      await Promise.resolve();
   }
}

/**
 * Test subclass that captures dispatches in a list (instead of calling into a
 * real workspace lock + document builder). Its `trigger*` helpers drive
 * `fireDocumentUpdate` with a single URI, the way `super.didChangeContent`
 * would, so tests need not stage a full `TextDocumentChangeEvent`.
 */
class CapturingHandler extends HydraniumDocumentUpdateHandler {
   public readonly dispatchCalls: DispatchCall[] = [];

   protected override dispatch(changed: URI[], deleted: URI[]): void {
      this.dispatchCalls.push({ changed: [...changed], deleted: [...deleted] });
   }

   /** Public test hook — bypass the change-event plumbing and drive `fireDocumentUpdate` directly. */
   public triggerChange(changedUri: string): void {
      this['fireDocumentUpdate']([URI.parse(changedUri)], []);
   }

   public triggerDelete(deletedUri: string): void {
      this['fireDocumentUpdate']([], [URI.parse(deletedUri)]);
   }

   /** Public test hook for the protected, async self-save filter. */
   public filterSelfSavesPublic(params: DidChangeWatchedFilesParams): Promise<DidChangeWatchedFilesParams> {
      return this.filterSelfSaves(params);
   }

   /** Drive `didChangeContent` through the public surface; the `getAuthor` stub decides which branch it takes. */
   public simulateNonLanguageClientChange(uri: string): void {
      const event: TextDocumentChangeEvent<{ uri: string }> = {
         document: { uri }
      } as TextDocumentChangeEvent<{ uri: string }>;
      this.didChangeContent(event as TextDocumentChangeEvent<never>);
   }

   public simulateLanguageClientChange(uri: string): void {
      const event: TextDocumentChangeEvent<{ uri: string }> = {
         document: { uri }
      } as TextDocumentChangeEvent<{ uri: string }>;
      this.didChangeContent(event as TextDocumentChangeEvent<never>);
   }
}

interface ServicesStubOptions {
   getAuthor?: (uri: string) => string | undefined;
   isOpenInAnyClient?: (uri: string) => boolean;
   /** Drives `SelfSaveRegistry.isRegistered`. Defaults to `() => false` (no self-save match). */
   selfSaveRegistered?: (fsPath: string, mtimeMs: number) => boolean;
   /** Optional bookkeeping side-channels. When provided, the stub appends to these arrays. */
   markNextReasonCalls?: Array<string | undefined>;
   loggedErrors?: string[];
   /** Clock bound on the `Clock` slot. Pass a `makeFakeClock()` to drive the debounce timer; defaults to a real `SystemClock`. */
   clock?: Clock;
   /**
    * Drives the `FileSystemProvider.mtimeMs` seam the handler reads through.
    * Defaults to {@link STUB_MTIME_MS}. Return `undefined` to model a failed
    * stat. Kept off the real filesystem deliberately: an injected constant
    * makes the value the handler forwards to `SelfSaveRegistry.isRegistered`
    * independently observable, whereas a real stat on both sides of the
    * assertion would pass even if the handler bypassed this seam entirely.
    */
   mtimeMs?: (uri: URI) => Promise<number | undefined>;
}

function makeServicesStub(opts: ServicesStubOptions = {}): ServerSharedServices {
   const getAuthor = opts.getAuthor ?? (() => LANGUAGE_CLIENT_ID);
   const isOpenInAnyClient = opts.isOpenInAnyClient ?? (() => false);
   const selfSaveRegistered = opts.selfSaveRegistered ?? (() => false);
   const markNextReasonCalls = opts.markNextReasonCalls;
   const loggedErrors = opts.loggedErrors;
   // `DefaultDocumentUpdateHandler` constructor subscribes to
   // `services.lsp.LanguageServer.onInitialize` / `onInitialized` — stub
   // both as no-op subscribers so construction completes.
   const noOpEvent = (): void => undefined;
   return {
      ServiceRegistry: {},
      // Debounce tests pass a makeFakeClock() to drive the timer with
      // `clock.advance(...)`; non-timer tests use the real SystemClock default.
      Clock: opts.clock ?? new SystemClock(),
      Logger: {
         error: (msg: string) => loggedErrors?.push(msg)
      },
      Tracer: makeNoopTracer(),
      lsp: {
         LanguageServer: { onInitialize: noOpEvent, onInitialized: noOpEvent }
      },
      workspace: {
         WorkspaceManager: { ready: Promise.resolve() },
         DocumentBuilder: {
            update: () => Promise.resolve(),
            markNextReason: (reason: string | undefined) => markNextReasonCalls?.push(reason)
         },
         WorkspaceLock: { write: (cb: (token: unknown) => unknown) => cb(undefined) },
         TextDocuments: { getAuthor, isOpenInAnyClient },
         SelfSaveRegistry: { isRegistered: selfSaveRegistered },
         // The handler reads the file mtime through the FileSystemProvider
         // seam, so these tests need no filesystem at all; the Node provider's
         // own stat behaviour is covered by its own tests.
         FileSystemProvider: {
            mtimeMs: opts.mtimeMs ?? (async () => STUB_MTIME_MS)
         }
      }
   } as unknown as ServerSharedServices;
}

/** Build a ObservableValue<number> that tests can drive via `set()`. */
function makeObservable(initial: number): ObservableValue<number> & { set: (next: number) => void } {
   const emitter = new Emitter<number>();
   let current = initial;
   return {
      get value(): number {
         return current;
      },
      onChange: emitter.event,
      set(next: number): void {
         current = next;
         emitter.fire(next);
      }
   };
}

describe('HydraniumDocumentUpdateHandler — debounce off (default)', () => {
   it('flushes synchronously when `debounceMs` is unset (default 0)', () => {
      const handler = new CapturingHandler(makeServicesStub());
      handler.triggerChange('file:///a.a');
      expect(handler.dispatchCalls).toHaveLength(1);
      expect(handler.dispatchCalls[0].changed.map(u => u.toString())).toEqual(['file:///a.a']);
      expect(handler.dispatchCalls[0].deleted).toEqual([]);
   });

   it('flushes synchronously when `debounceMs` is explicitly 0', () => {
      const handler = new CapturingHandler(makeServicesStub(), { debounceMs: 0 });
      handler.triggerChange('file:///a.a');
      expect(handler.dispatchCalls).toHaveLength(1);
   });
});

describe('HydraniumDocumentUpdateHandler — debounce on', () => {
   it('schedules a timer instead of dispatching immediately', () => {
      const clock = makeFakeClock();
      const handler = new CapturingHandler(makeServicesStub({ clock }), { debounceMs: 50 });
      handler.triggerChange('file:///a.a');
      expect(handler.dispatchCalls).toEqual([]);
      clock.advance(50);
      expect(handler.dispatchCalls).toHaveLength(1);
   });

   it('coalesces rapid changes into a single dispatch with merged URIs', () => {
      const clock = makeFakeClock();
      const handler = new CapturingHandler(makeServicesStub({ clock }), { debounceMs: 50 });
      handler.triggerChange('file:///a.a');
      handler.triggerChange('file:///b.a');
      handler.triggerChange('file:///a.a'); // dedup
      clock.advance(50);
      expect(handler.dispatchCalls).toHaveLength(1);
      const uris = handler.dispatchCalls[0].changed.map(u => u.toString()).sort();
      expect(uris).toEqual(['file:///a.a', 'file:///b.a']);
   });

   it('restarts the timer on the second change (trailing-edge debounce)', () => {
      const clock = makeFakeClock();
      const handler = new CapturingHandler(makeServicesStub({ clock }), { debounceMs: 50 });
      handler.triggerChange('file:///a.a');
      clock.advance(30);
      handler.triggerChange('file:///b.a'); // restarts the timer
      clock.advance(30);
      expect(handler.dispatchCalls).toEqual([]); // would fire at 60ms if NOT restarted
      clock.advance(20);
      expect(handler.dispatchCalls).toHaveLength(1);
   });

   it('deletes supersede pending changes for the same URI', () => {
      const clock = makeFakeClock();
      const handler = new CapturingHandler(makeServicesStub({ clock }), { debounceMs: 50 });
      handler.triggerChange('file:///a.a');
      handler.triggerDelete('file:///a.a');
      clock.advance(50);
      expect(handler.dispatchCalls).toHaveLength(1);
      expect(handler.dispatchCalls[0].changed).toEqual([]);
      expect(handler.dispatchCalls[0].deleted.map(u => u.toString())).toEqual(['file:///a.a']);
   });

   it('flushPending() drains immediately and clears the timer', () => {
      const clock = makeFakeClock();
      const handler = new CapturingHandler(makeServicesStub({ clock }), { debounceMs: 50 });
      handler.triggerChange('file:///a.a');
      handler.flushPending();
      expect(handler.dispatchCalls).toHaveLength(1);
      clock.advance(50);
      expect(handler.dispatchCalls).toHaveLength(1); // timer already cleared
   });

   it('flushPending() with no pending work is a no-op', () => {
      const handler = new CapturingHandler(makeServicesStub(), { debounceMs: 50 });
      handler.flushPending();
      expect(handler.dispatchCalls).toEqual([]);
   });

   it('resets immediateFlush after an immediate flush so the next change debounces', () => {
      // Pins the `immediateFlush = false` reset in fireDocumentUpdate: a
      // non-language-client change flushes immediately, but the flag must clear
      // so a subsequent language-client (typing) change debounces normally
      // rather than being flushed immediately too.
      const clock = makeFakeClock();
      let author = 'glsp-client';
      const handler = new CapturingHandler(makeServicesStub({ getAuthor: () => author, clock }), { debounceMs: 50 });
      handler.simulateNonLanguageClientChange('file:///a.a');
      expect(handler.dispatchCalls).toHaveLength(1); // bypassed: immediate
      author = LANGUAGE_CLIENT_ID;
      handler.simulateLanguageClientChange('file:///b.a');
      expect(handler.dispatchCalls).toHaveLength(1); // debounced, NOT flushed immediately
      clock.advance(50);
      expect(handler.dispatchCalls).toHaveLength(2);
   });
});

describe('HydraniumDocumentUpdateHandler — bypassNonLanguageClientChanges', () => {
   it('bypasses debouncing when getAuthor !== LANGUAGE_CLIENT_ID (default true)', () => {
      const handler = new CapturingHandler(makeServicesStub({ getAuthor: () => 'glsp-client' }), { debounceMs: 50 });
      handler.simulateNonLanguageClientChange('file:///a.a');
      expect(handler.dispatchCalls).toHaveLength(1);
   });

   it('still debounces when getAuthor === LANGUAGE_CLIENT_ID', () => {
      const clock = makeFakeClock();
      const handler = new CapturingHandler(makeServicesStub({ getAuthor: () => LANGUAGE_CLIENT_ID, clock }), { debounceMs: 50 });
      handler.simulateLanguageClientChange('file:///a.a');
      expect(handler.dispatchCalls).toEqual([]);
      clock.advance(50);
      expect(handler.dispatchCalls).toHaveLength(1);
   });

   it('still debounces a non-LC change when bypass is disabled', () => {
      const clock = makeFakeClock();
      const handler = new CapturingHandler(makeServicesStub({ getAuthor: () => 'glsp-client', clock }), {
         debounceMs: 50,
         bypassNonLanguageClientChanges: false
      });
      handler.simulateNonLanguageClientChange('file:///a.a');
      expect(handler.dispatchCalls).toEqual([]);
      clock.advance(50);
      expect(handler.dispatchCalls).toHaveLength(1);
   });
});

describe('HydraniumDocumentUpdateHandler — MaybeObservableValue<number> for debounceMs', () => {
   it('accepts a static number', () => {
      const clock = makeFakeClock();
      const handler = new CapturingHandler(makeServicesStub({ clock }), { debounceMs: 75 });
      handler.triggerChange('file:///a.a');
      clock.advance(74);
      expect(handler.dispatchCalls).toEqual([]);
      clock.advance(1);
      expect(handler.dispatchCalls).toHaveLength(1);
   });

   it('accepts a ObservableValue<number> and re-reads the window on `onChange`', () => {
      const clock = makeFakeClock();
      const config = makeObservable(50);
      const handler = new CapturingHandler(makeServicesStub({ clock }), { debounceMs: config });
      // First debounce at 50ms.
      handler.triggerChange('file:///a.a');
      clock.advance(50);
      expect(handler.dispatchCalls).toHaveLength(1);

      // Live update — next change uses the new window.
      config.set(200);
      handler.triggerChange('file:///b.a');
      clock.advance(50);
      expect(handler.dispatchCalls).toHaveLength(1); // 50ms is not yet 200ms
      clock.advance(150);
      expect(handler.dispatchCalls).toHaveLength(2);
   });
});

describe('HydraniumDocumentUpdateHandler — reason stamping', () => {
   // These use a BARE handler, not `CapturingHandler`, so the real `dispatch`
   // runs and the reason reaches the `markNextReason` side-channel on the
   // services stub. `dispatch` then calls `documentBuilder.update`, itself a
   // stub returning a resolved promise, so the ordering under assertion
   // (reason staged before update) settles deterministically.

   it('didOpenDocument stamps `didOpen` and bypasses debouncing', async () => {
      const markNextReasonCalls: Array<string | undefined> = [];
      const services = makeServicesStub({ markNextReasonCalls });
      const handler = new HydraniumDocumentUpdateHandler(services, { debounceMs: 50 });
      const event = { document: { uri: 'file:///a.a' } } as TextDocumentChangeEvent<TextDocument>;
      handler.didOpenDocument(event);
      handler.didChangeContent(event);
      // The didChangeContent override sees `nextReason === 'didOpen'`
      // already set (via the `??=`) and inherits it; immediateFlush
      // bypasses the debounce window.
      await flushMicrotasks();
      expect(markNextReasonCalls).toEqual(['didOpen']);
   });

   it('didChangeContent alone stamps `didChangeContent`', async () => {
      const markNextReasonCalls: Array<string | undefined> = [];
      const services = makeServicesStub({ markNextReasonCalls });
      const handler = new HydraniumDocumentUpdateHandler(services);
      const event = { document: { uri: 'file:///a.a' } } as TextDocumentChangeEvent<TextDocument>;
      handler.didChangeContent(event);
      await flushMicrotasks();
      expect(markNextReasonCalls).toEqual(['didChangeContent']);
   });

   it('coalesced didChangeContent burst forwards a single reason on the trailing flush', async () => {
      const clock = makeFakeClock();
      const markNextReasonCalls: Array<string | undefined> = [];
      const services = makeServicesStub({ markNextReasonCalls, clock });
      const handler = new HydraniumDocumentUpdateHandler(services, { debounceMs: 50 });
      const event = { document: { uri: 'file:///a.a' } } as TextDocumentChangeEvent<TextDocument>;
      handler.didChangeContent(event);
      handler.didChangeContent(event);
      handler.didChangeContent(event);
      expect(markNextReasonCalls).toEqual([]); // still debounced
      clock.advance(50); // fires the trailing flush → dispatch (synchronous part)
      // makeFakeClock fakes only our clock, so real microtasks flow — the
      // dispatch's `.then` chain settles with a plain microtask flush (no
      // fake-timer / real-timer juggling).
      await flushMicrotasks();
      expect(markNextReasonCalls).toEqual(['didChangeContent']);
   });

   it('didChangeWatchedFiles stamps `didChangeWatchedFiles` (overwriting any prior reason)', async () => {
      const markNextReasonCalls: Array<string | undefined> = [];
      const services = makeServicesStub({ markNextReasonCalls });
      const handler = new HydraniumDocumentUpdateHandler(services);
      // Stage a `didChangeContent` reason first — the watched-files event
      // must overwrite it (the watcher fires for an external write, which
      // is the more interesting trigger to log than the racing edit).
      handler.didChangeContent({ document: { uri: 'file:///a.a' } } as TextDocumentChangeEvent<TextDocument>);
      await flushMicrotasks();
      // didChangeContent fired with debounceMs=0 default → already flushed.
      markNextReasonCalls.length = 0;
      handler.didChangeWatchedFiles({
         changes: [{ uri: 'file:///b.a', type: 1 /* Created */ }]
      });
      // didChangeWatchedFiles filters self-saves asynchronously through the
      // `mtimeMs` seam (the default stub reports no registry match, so the
      // change survives). Drain the task queue before microtask-flushing the
      // dispatch chain.
      await new Promise(resolve => setTimeout(resolve, 10));
      await flushMicrotasks();
      expect(markNextReasonCalls).toEqual(['didChangeWatchedFiles']);
   });

   it('didCloseDocument dispatches update([uri], []) on last close of a file: URI', () => {
      // Observes the rebuild TRIGGER, not the disk re-read: Langium's
      // `factory.update` handles the latter downstream, consulting the
      // LSP-tracked open-docs map first and falling back to the
      // FileSystemProvider when absent — which is the case on last close.
      const handler = new CapturingHandler(makeServicesStub({ isOpenInAnyClient: () => false }));
      handler.didCloseDocument({ document: { uri: 'file:///a.a' } } as TextDocumentChangeEvent<TextDocument>);
      expect(handler.dispatchCalls).toHaveLength(1);
      expect(handler.dispatchCalls[0].changed.map(u => u.toString())).toEqual(['file:///a.a']);
      expect(handler.dispatchCalls[0].deleted).toEqual([]);
   });

   it('didCloseDocument bypasses debouncing — dispatches synchronously even with a debounce window', () => {
      // Pins the `immediateFlush = true` stamp in didCloseDocument: with a
      // non-zero window the dispatch would otherwise be scheduled on the timer,
      // not fired synchronously. The close must rebuild immediately so the
      // LangiumDocument refreshes from disk before the next consumer reads it.
      const clock = makeFakeClock();
      const handler = new CapturingHandler(makeServicesStub({ isOpenInAnyClient: () => false, clock }), { debounceMs: 50 });
      handler.didCloseDocument({ document: { uri: 'file:///a.a' } } as TextDocumentChangeEvent<TextDocument>);
      expect(handler.dispatchCalls).toHaveLength(1); // synchronous, not waiting for the timer
   });

   it('didCloseDocument suppresses dispatch when other clients still hold the URI', () => {
      // Per-client close in a multi-client setup: another client still
      // has the doc open, so the in-memory text is still authoritative.
      // No rebuild trigger.
      const handler = new CapturingHandler(makeServicesStub({ isOpenInAnyClient: () => true }));
      handler.didCloseDocument({ document: { uri: 'file:///a.a' } } as TextDocumentChangeEvent<TextDocument>);
      expect(handler.dispatchCalls).toEqual([]);
   });

   it('didCloseDocument leaves non-file URIs alone (preserves adopter-loaded docs like builtin:)', () => {
      // An adopter's `builtin:` documents are loaded via
      // `loadAdditionalDocuments` and must stay in the workspace index for
      // the lifetime of the server — dropping them on close would break
      // every cross-reference that resolves through universal-tier scope.
      // The framework cannot enumerate adopter schemes, so the safe default
      // is "no dispatch for non-file URIs."
      const handler = new CapturingHandler(makeServicesStub({ isOpenInAnyClient: () => false }));
      handler.didCloseDocument({ document: { uri: 'builtin:///Element.a' } } as TextDocumentChangeEvent<TextDocument>);
      handler.didCloseDocument({ document: { uri: 'untitled:Untitled-1' } } as TextDocumentChangeEvent<TextDocument>);
      expect(handler.dispatchCalls).toEqual([]);
   });

   it('didCloseDocument stamps the build reason `didClose`', async () => {
      const markNextReasonCalls: Array<string | undefined> = [];
      const services = makeServicesStub({ markNextReasonCalls, isOpenInAnyClient: () => false });
      const handler = new HydraniumDocumentUpdateHandler(services);
      handler.didCloseDocument({ document: { uri: 'file:///a.a' } } as TextDocumentChangeEvent<TextDocument>);
      // Dispatch is microtask-deferred via workspaceManager.ready.then(...).
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(markNextReasonCalls).toEqual(['didClose']);
   });

   it('error path uses `services.Logger.error` instead of console.error', async () => {
      const loggedErrors: string[] = [];
      const services = makeServicesStub({ loggedErrors });
      // Replace WorkspaceManager.ready with a rejecting promise so dispatch
      // takes the .catch branch.
      const stubServices = services as unknown as {
         workspace: { WorkspaceManager: { ready: Promise<unknown> } };
      };
      stubServices.workspace.WorkspaceManager.ready = Promise.reject(new Error('boom'));
      const handler = new HydraniumDocumentUpdateHandler(services);
      handler.didChangeContent({ document: { uri: 'file:///a.a' } } as TextDocumentChangeEvent<TextDocument>);
      // Microtask flush so the .catch runs.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(loggedErrors).toHaveLength(1);
      expect(loggedErrors[0]).toMatch(/Workspace initialization failed/);
      expect(loggedErrors[0]).toMatch(/boom/);
   });
});

describe('HydraniumDocumentUpdateHandler — didChangeWatchedFiles dispatch', () => {
   it('short-circuits — never calls super.didChangeWatchedFiles when every change is a self-save', async () => {
      // Pins the `if (filtered.changes.length === 0) return;` guard. The
      // dispatch level can't distinguish (an empty super call dispatches
      // nothing either way), so observe `onWatchedFilesChange`: Langium's
      // super.didChangeWatchedFiles fires that emitter unconditionally, so the
      // guard is the only thing that keeps it from firing on a wholly-filtered
      // (self-save echo) batch.
      const matchCalls: Array<{ fsPath: string; mtimeMs: number }> = [];
      const handler = new CapturingHandler(
         makeServicesStub({
            selfSaveRegistered: (fsPath, mtimeMs) => {
               matchCalls.push({ fsPath, mtimeMs });
               return true;
            }
         })
      );
      const watchedFilesEvents: DidChangeWatchedFilesParams[] = [];
      handler.onWatchedFilesChange(params => watchedFilesEvents.push(params));
      handler.didChangeWatchedFiles({
         changes: [{ uri: WATCHED_URI, type: FileChangeType.Changed }]
      });
      await flushMicrotasks();
      // Assert the POSITIVE signal first: the filter actually ran. Without it
      // the negative assertions below would also hold for a batch that
      // merely hadn't been processed yet, so the test would still pass with the
      // short-circuit guard deleted.
      expect(matchCalls).toHaveLength(1);
      expect(handler.dispatchCalls).toEqual([]);
      expect(watchedFilesEvents).toEqual([]);
   });

   it('bypasses debouncing — a surviving watched-file change dispatches synchronously', async () => {
      // Pins the `immediateFlush = true` stamp: with a non-zero window the
      // surviving change would be scheduled on the timer rather than dispatched
      // on the trailing edge of super.didChangeWatchedFiles' fireDocumentUpdate.
      const clock = makeFakeClock();
      const handler = new CapturingHandler(makeServicesStub({ selfSaveRegistered: () => false, clock }), { debounceMs: 50 });
      handler.didChangeWatchedFiles({
         changes: [{ uri: WATCHED_URI, type: FileChangeType.Changed }]
      });
      await flushMicrotasks();
      // immediateFlush fired the dispatch without any clock.advance(50).
      expect(handler.dispatchCalls).toHaveLength(1);
      expect(handler.dispatchCalls[0].changed.map(u => u.toString())).toEqual([WATCHED_URI]);
   });
});

describe('HydraniumDocumentUpdateHandler — filterSelfSaves', () => {
   // No filesystem here: the handler reads the mtime through the
   // `FileSystemProvider.mtimeMs` seam, so an injected constant pins the
   // `uri → fsPath` + mtime pair the handler forwards to
   // `SelfSaveRegistry.isRegistered`. Statting a real temp file on BOTH sides of
   // that assertion would compare fs against itself and still pass if the
   // handler bypassed the seam.

   it('drops a change whose path + mtime match the self-save registry', async () => {
      const matchCalls: Array<{ fsPath: string; mtimeMs: number }> = [];
      const handler = new CapturingHandler(
         makeServicesStub({
            selfSaveRegistered: (fsPath, mtimeMs) => {
               matchCalls.push({ fsPath, mtimeMs });
               return true;
            }
         })
      );
      const params: DidChangeWatchedFilesParams = {
         changes: [{ uri: WATCHED_URI, type: FileChangeType.Changed }]
      };
      const filtered = await handler.filterSelfSavesPublic(params);
      expect(filtered.changes).toEqual([]);
      // The registry is consulted with the derived fsPath + the provider's mtime.
      expect(matchCalls).toEqual([{ fsPath: WATCHED_FS_PATH, mtimeMs: STUB_MTIME_MS }]);
   });

   it('passes a change through when the self-save registry does not match', async () => {
      const handler = new CapturingHandler(makeServicesStub({ selfSaveRegistered: () => false }));
      const params: DidChangeWatchedFilesParams = {
         changes: [{ uri: WATCHED_URI, type: FileChangeType.Changed }]
      };
      const filtered = await handler.filterSelfSavesPublic(params);
      expect(filtered.changes).toHaveLength(1);
      expect(filtered.changes[0].uri).toEqual(WATCHED_URI);
   });

   it('passes deletions through without consulting stat or the registry', async () => {
      let matchesCalled = false;
      const mtimeCalls: string[] = [];
      const handler = new CapturingHandler(
         makeServicesStub({
            selfSaveRegistered: () => {
               matchesCalled = true;
               return true;
            },
            // Would report a matching mtime if consulted, so the assertions
            // prove the deletion short-circuit rather than an absent file.
            mtimeMs: async uri => {
               mtimeCalls.push(uri.fsPath);
               return STUB_MTIME_MS;
            }
         })
      );
      const params: DidChangeWatchedFilesParams = {
         changes: [{ uri: WATCHED_URI, type: FileChangeType.Deleted }]
      };
      const filtered = await handler.filterSelfSavesPublic(params);
      expect(filtered.changes).toHaveLength(1);
      expect(filtered.changes[0]).toEqual({ uri: WATCHED_URI, type: FileChangeType.Deleted });
      expect(matchesCalled).toBe(false);
      // Stronger than the registry check alone: the seam was never touched.
      expect(mtimeCalls).toEqual([]);
   });

   it('passes a change through when the mtime is unavailable (failed-stat fallback)', async () => {
      let matchesCalled = false;
      const handler = new CapturingHandler(
         makeServicesStub({
            selfSaveRegistered: () => {
               matchesCalled = true;
               return true;
            },
            mtimeMs: async () => undefined
         })
      );
      const params: DidChangeWatchedFilesParams = {
         changes: [{ uri: WATCHED_URI, type: FileChangeType.Changed }]
      };
      const filtered = await handler.filterSelfSavesPublic(params);
      expect(filtered.changes).toHaveLength(1);
      expect(filtered.changes[0].uri).toEqual(WATCHED_URI);
      // No mtime means the registry cannot be keyed, so the change passes.
      expect(matchesCalled).toBe(false);
   });
});
