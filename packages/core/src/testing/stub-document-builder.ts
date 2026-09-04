/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type DocumentBuilder,
   type DocumentPhaseListener,
   type DocumentState,
   type DocumentUpdateListener,
   type LangiumDocument,
   type URI
} from '@hydranium/langium';
import { type CancellationToken, Disposable } from 'vscode-languageserver';

/** Recorded call to a stubbed {@link DocumentBuilder} method. */
export interface RecordedBuilderCall<TArgs extends unknown[]> {
   readonly args: TArgs;
}

/**
 * Handle over one held {@link StubDocumentBuilder.waitUntil} call.
 *
 * **Consumption is observable on purpose**: a handle whose `resolve()` silently
 * did nothing would let "the gate released the wait" and "the subject never
 * reached the wait" produce identical, green runs.
 */
export interface StubWaitUntilGate {
   /**
    * Release the held call.
    *
    * **Throws if no `waitUntil` ever took this gate**, and drops the gate from
    * the queue on the way out — an unconsumed gate is FIFO-handed to the next
    * `waitUntil`, which may belong to an unrelated later test, where it parks a
    * call nobody meant to hold.
    */
   resolve(): void;
   /** Whether a {@link StubDocumentBuilder.waitUntil} call has taken this gate. */
   readonly consumed: boolean;
}

/**
 * Stub for Langium's {@link DocumentBuilder}. Implements the slice production
 * code reads from on the framework's test paths (`update` / `waitUntil` /
 * `onDocumentPhase` / `onUpdate`) plus test-only helpers:
 *
 * - {@link firePhase} — synchronously dispatch the registered phase
 *   listener(s) for a document, simulating a build completing.
 * - {@link fireOnUpdate} — invoke `onUpdate` subscribers with synthetic
 *   changed / deleted URI lists, simulating Langium's update fan-out.
 * - {@link gateNextWaitUntil} — defer the next {@link waitUntil} resolution
 *   until the returned `resolve()` is called, simulating a long-running
 *   build that lets a caller observe the in-flight state.
 *
 * Recorded `updateCalls` / `waitUntilCalls` allow assertions on the
 * arguments the consumer passed.
 *
 * # Stub-vs-real surface
 *
 * Picks the methods the framework reads from {@link DocumentBuilder} on
 * the slot path — the compiler enforces those signatures stay aligned.
 * `update`, `onDocumentPhase`, `onUpdate`, and `waitUntil` carry stubbed
 * implementations; `build`, `onBuildPhase`, and `resetToState` are
 * implemented as loud-failing `notSupported` throwers so production code
 * that goes through the cast at the bind site (i.e. accesses methods the
 * stub claims but doesn't meaningfully implement) fails with a clear
 * message instead of "undefined is not a function".
 */
export interface StubDocumentBuilder extends Pick<
   DocumentBuilder,
   'update' | 'onDocumentPhase' | 'onUpdate' | 'build' | 'onBuildPhase' | 'resetToState'
> {
   /**
    * Single-overload stub of {@link DocumentBuilder.waitUntil}. Real has
    * two overloads (`(state, cancelToken?): Promise<void>` and
    * `(state, uri?, cancelToken?): Promise<URI | undefined>`) that can't
    * be expressed as a single object-literal method type, so the stub
    * declares only the more general second form. Tests pass cancelToken
    * by name if needed (the stub ignores it).
    */
   waitUntil(state: DocumentState, uri?: URI): Promise<URI | undefined>;
   readonly updateCalls: ReadonlyArray<RecordedBuilderCall<[URI[], URI[]]>>;
   readonly waitUntilCalls: ReadonlyArray<RecordedBuilderCall<[DocumentState, URI | undefined]>>;
   /**
    * Synchronously fire the phase listener(s) registered for `state` with
    * `document`. `cancelToken` defaults to a non-cancelled token; pass a
    * cancelled token to simulate a build preempted by a concurrent write
    * lock.
    */
   firePhase(state: DocumentState, document: LangiumDocument, cancelToken?: CancellationToken): void;
   /** Synchronously fire every registered `onUpdate` listener. */
   fireOnUpdate(changed: URI[], deleted: URI[]): void;
   /**
    * Hold the next {@link waitUntil} call. The returned handle releases it;
    * the call's return value resolves on the next tick after `resolve` runs.
    */
   gateNextWaitUntil(): StubWaitUntilGate;
   /** Drop recorded state and gates. Useful for `beforeEach`-style resets. */
   reset(): void;
}

/**
 * Re-raise a listener's asynchronous failure instead of discarding it.
 *
 * These dispatchers are synchronous, so a listener's promise cannot be awaited
 * and `void` on it drops the rejection entirely — a phase listener that fails
 * asynchronously leaves the test green while the code under test threw. Raising
 * it as an uncaught exception is the only channel a `void`-returning dispatcher
 * has, and is what every runner already reports. A test that legitimately
 * expects a listener to reject must assert on it directly rather than firing a
 * phase and ignoring the result.
 */
function reraise(result: unknown): void {
   void Promise.resolve(result).catch((error: unknown) => {
      queueMicrotask(() => {
         throw error;
      });
   });
}

/**
 * Build a {@link StubDocumentBuilder}. The stub is grammar-free and never
 * actually parses; the `update` method only records its args. Tests that
 * want to observe rebuilt state should `set` the new root on the document
 * registry and then call `firePhase` to trigger the framework's post-build
 * read path.
 */
export function makeStubDocumentBuilder(): StubDocumentBuilder {
   const phaseListeners = new Map<DocumentState, DocumentPhaseListener[]>();
   const onUpdateListeners: DocumentUpdateListener[] = [];
   const gates: Array<{ take(release: () => void): void }> = [];
   const updateCalls: RecordedBuilderCall<[URI[], URI[]]>[] = [];
   const waitUntilCalls: RecordedBuilderCall<[DocumentState, URI | undefined]>[] = [];

   const notSupported = (method: string): never => {
      throw new Error(`StubDocumentBuilder.${method} is not implemented; wire a real DocumentBuilder if your test needs it.`);
   };
   const stub: StubDocumentBuilder = {
      get updateCalls() {
         return updateCalls;
      },
      get waitUntilCalls() {
         return waitUntilCalls;
      },
      async update(changed: URI[], deleted: URI[]) {
         updateCalls.push({ args: [changed, deleted] });
      },
      async waitUntil(state: DocumentState, uri?: URI) {
         waitUntilCalls.push({ args: [state, uri] });
         const gate = gates.shift();
         if (gate) {
            await new Promise<void>(resolve => gate.take(resolve));
         }
         return uri;
      },
      onDocumentPhase(state: DocumentState, listener: DocumentPhaseListener) {
         const list = phaseListeners.get(state) ?? [];
         list.push(listener);
         phaseListeners.set(state, list);
         return Disposable.create(() => {
            const idx = list.indexOf(listener);
            if (idx >= 0) {
               list.splice(idx, 1);
            }
         });
      },
      onUpdate(listener: DocumentUpdateListener) {
         onUpdateListeners.push(listener);
         return Disposable.create(() => {
            const idx = onUpdateListeners.indexOf(listener);
            if (idx >= 0) {
               onUpdateListeners.splice(idx, 1);
            }
         });
      },
      firePhase(state: DocumentState, document: LangiumDocument, cancelToken?: CancellationToken) {
         const token =
            cancelToken ??
            ({
               isCancellationRequested: false,
               onCancellationRequested: () => Disposable.create(() => undefined)
            } as CancellationToken);
         const listeners = phaseListeners.get(state) ?? [];
         for (const listener of listeners) {
            reraise(listener(document, token));
         }
      },
      fireOnUpdate(changed: URI[], deleted: URI[]) {
         for (const listener of onUpdateListeners.slice()) {
            reraise(listener(changed, deleted));
         }
      },
      gateNextWaitUntil(): StubWaitUntilGate {
         let release: (() => void) | undefined;
         const entry = {
            take(resolve: () => void): void {
               release = resolve;
            }
         };
         gates.push(entry);
         return {
            get consumed(): boolean {
               return release !== undefined;
            },
            resolve(): void {
               if (!release) {
                  const queued = gates.indexOf(entry);
                  if (queued >= 0) {
                     gates.splice(queued, 1);
                  }
                  throw new Error(
                     'StubDocumentBuilder: gateNextWaitUntil().resolve() ran before any waitUntil took the gate. ' +
                        'Nothing was held, so releasing it proves nothing — wait until `waitUntilCalls` records the call first.'
                  );
               }
               release();
            }
         };
      },
      build() {
         return notSupported('build');
      },
      onBuildPhase() {
         return notSupported('onBuildPhase');
      },
      resetToState() {
         return notSupported('resetToState');
      },
      reset() {
         phaseListeners.clear();
         onUpdateListeners.length = 0;
         gates.length = 0;
         updateCalls.length = 0;
         waitUntilCalls.length = 0;
      }
   };
   return stub;
}
