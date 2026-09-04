/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { ClientId, GModelIndex, GModelSerializer, ModelState, SOURCE_URI_ARG } from '@eclipse-glsp/server';
import 'reflect-metadata';
import { Container, injectable } from 'inversify';
import { type AstNode, DocumentState } from '@hydranium/langium';
import type { ElementKeyProvider, ServerSharedServices } from '@hydranium/core';
import { HydraniumGlspIndex } from '../src/state/hydranium-glsp-index.js';
import { AbstractHydraniumGlspState } from '../src/state/abstract-hydranium-glsp-state.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';
import { ModelReadyTimeoutError } from '../src/state/model-ready-timeout-error.js';
import { ReconcilingConflictResolver } from '@hydranium/protocol';
import { type FakeClock, makeFakeClock } from '@hydranium/protocol/testing';
import { makeFakeAstNode, makeStubServiceRegistry } from '@hydranium/core/testing';
import { URI } from '@hydranium/langium';

interface TestRoot extends AstNode {
   readonly $type: 'TestRoot';
   readonly label: string;
}

interface LoggerHarness {
   readonly warns: string[];
   readonly timeLabels: string[];
   readonly withUris: string[];
}

interface FakeDocument {
   uri: { toString(): string };
   state: DocumentState;
   parseResult: { value: AstNode };
   textDocument?: { version: number };
}

interface StateHarness {
   readonly logger: LoggerHarness;
   readonly idMap: Map<AstNode, string | undefined>;
   readonly documents: Map<string, FakeDocument>;
   /**
    * Every uri `ModelService.getDocument` was asked for, in call order —
    * including an `undefined` one, which a plain `Map.get` would answer
    * silently. Lets a test assert that a guarded path never reached the
    * lookup at all.
    */
   readonly documentLookups: (string | undefined)[];
   /** Fake clock bound on the `Clock` slot — tests advance it to fire the ready-timeout. */
   readonly clock: FakeClock;
   /** Promise the stubbed `waitForDocumentState` returns. Tests reassign per case. */
   waitForDocumentStatePromise: () => Promise<void>;
}

@injectable()
class TestState extends AbstractHydraniumGlspState<TestRoot> {
   public updatedSourceModels: string[] = [];

   async updateSourceModel(text: string): Promise<void> {
      this.updatedSourceModels.push(text);
   }

   /** Test-only: shorten the one-minute default so timeout cases are fast. */
   setReadyTimeoutMs(value: number): void {
      this.readyTimeoutMs = value;
   }

   /** Expose for tests; default protected. */
   public callRefreshSourceRoot(): void {
      this.refreshSourceRoot();
   }
}

function makeHarness(): StateHarness {
   return {
      logger: { warns: [], timeLabels: [], withUris: [] },
      idMap: new Map(),
      documents: new Map(),
      documentLookups: [],
      clock: makeFakeClock(),
      waitForDocumentStatePromise: () => new Promise(() => undefined)
   };
}

function createState(harness: StateHarness): { state: TestState; container: Container } {
   const childLogger = {
      info(_msg: string): void {
         /* swallow */
      },
      warn(msg: string): void {
         harness.logger.warns.push(msg);
      },
      error(_msg: string): void {
         /* swallow */
      },
      debug(_msg: string): void {
         /* swallow */
      },
      async time<T>(label: string, callback: () => Promise<T> | T): Promise<T> {
         harness.logger.timeLabels.push(label);
         return await callback();
      }
   };
   const elementKeyProvider: Pick<ElementKeyProvider, 'getElementKey'> = {
      getElementKey(node?: AstNode): string | undefined {
         return node ? harness.idMap.get(node) : undefined;
      }
   };
   // Two registered languages: `.a` is the diagram's own (carrying the
   // harness id map the keying tests assert against), `.other` a foreign one
   // so a resolved language names which one answered.
   const registry = makeStubServiceRegistry([
      { languageId: 'main', fileExtensions: ['.a'], services: { references: { ElementKeyProvider: elementKeyProvider } } },
      { languageId: 'other', fileExtensions: ['.other'], services: { references: { ElementKeyProvider: elementKeyProvider } } }
   ]);
   const sharedServices = {
      ServiceRegistry: registry,
      Clock: harness.clock,
      Tracer: {
         for(_component: string) {
            return {
               withUri(uri: unknown): typeof childLogger {
                  harness.logger.withUris.push(String(uri));
                  return childLogger;
               }
            };
         }
      },
      workspace: {
         LangiumDocuments: {
            getDocument(uri: { toString(): string }): FakeDocument | undefined {
               return harness.documents.get(uri.toString());
            }
         },
         WorkspaceManager: {
            wsRelativePath(uri: unknown): string {
               return `ws/${String(uri)}`;
            }
         },
         DocumentBuilder: {
            formatBuildStatus(uri: unknown): string {
               return `status[${String(uri)}]`;
            }
         }
      },
      model: {
         ModelService: {
            waitForDocumentState(_uri: string, _state: DocumentState): Promise<void> {
               return harness.waitForDocumentStatePromise();
            },
            getDocument(uri: string): FakeDocument | undefined {
               harness.documentLookups.push(uri);
               return harness.documents.get(uri);
            }
         }
      }
   };
   const container = new Container();
   container.bind(HydraniumTypes.SharedCoreServices).toConstantValue(sharedServices as unknown as ServerSharedServices);
   container.bind(HydraniumTypes.Tracer).toConstantValue({
      withUri: (uri: unknown) => {
         harness.logger.withUris.push(String(uri));
         return childLogger;
      }
   } as never);
   container.bind(HydraniumTypes.ConflictResolver).toConstantValue(new ReconcilingConflictResolver());
   // What a diagram module's `declareLanguage()` would bind: this diagram type
   // edits `.a` documents.
   container.bind(HydraniumTypes.DiagramLanguage).toConstantValue(registry.languagesById.get('main')!);
   container.bind(HydraniumGlspIndex).toSelf().inSingletonScope();
   container.bind(GModelSerializer).toConstantValue({} as GModelSerializer);
   container.bind(GModelIndex).toService(HydraniumGlspIndex);
   container.bind(ClientId).toConstantValue('test-client');
   container.bind(ModelState).to(TestState).inSingletonScope();
   container.bind(TestState).toService(ModelState);
   return { state: container.get(TestState), container };
}

function makeRoot(label = 'r1'): TestRoot {
   return makeFakeAstNode<TestRoot>({ $type: 'TestRoot', label });
}

/** A root node carrying a `$document`, so `AstUtils` can route it. */
function nodeInDoc(uri: string): AstNode {
   return makeFakeAstNode<AstNode>({ $type: 'Thing', $document: { uri: URI.parse(uri) } });
}

describe('AbstractHydraniumGlspState', () => {
   describe('diagramLanguage / languageServicesFor', () => {
      it('exposes the declared diagram language', () => {
         const { state } = createState(makeHarness());
         expect(state.diagramLanguage?.LanguageMetaData.languageId).toBe('main');
      });

      it('exposes it BEFORE a source root is captured, since handlers are built first', () => {
         const { state } = createState(makeHarness());
         // No setSourceRoot yet — GLSP constructs operation handlers at
         // InitializeClientSession, so anything derived from sourceUri would
         // be unavailable here.
         expect(state.diagramLanguage?.LanguageMetaData.languageId).toBe('main');
      });

      it('warns when the loaded document does not route to the declared language', () => {
         const harness = makeHarness();
         const { state } = createState(harness);
         state.setSourceRoot('file:///a.other', makeRoot());
         expect(harness.logger.warns.some(line => line.includes("declares language 'main'") && line.includes("routes to 'other'"))).toBe(
            true
         );
      });

      it('stays quiet when the loaded document matches the declared language', () => {
         const harness = makeHarness();
         const { state } = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot());
         expect(harness.logger.warns.filter(line => line.includes('declares language'))).toEqual([]);
      });

      it('stays quiet for a document that routes nowhere', () => {
         const harness = makeHarness();
         const { state } = createState(harness);
         state.setSourceRoot('file:///a.unknown', makeRoot());
         expect(harness.logger.warns.filter(line => line.includes('declares language'))).toEqual([]);
      });

      it('resolves a foreign node own language, not the diagram one', () => {
         const { state } = createState(makeHarness());
         state.setSourceRoot('file:///a.a', makeRoot());
         expect(state.languageServicesFor(nodeInDoc('file:///b.other'))?.LanguageMetaData.languageId).toBe('other');
      });

      it('resolves a uri string', () => {
         const { state } = createState(makeHarness());
         state.setSourceRoot('file:///a.a', makeRoot());
         expect(state.languageServicesFor('file:///b.other')?.LanguageMetaData.languageId).toBe('other');
      });

      it('falls back to the diagram language for an unroutable target', () => {
         const { state } = createState(makeHarness());
         state.setSourceRoot('file:///a.a', makeRoot());
         expect(state.languageServicesFor('file:///b.unknown')?.LanguageMetaData.languageId).toBe('main');
         expect(state.languageServicesFor(makeFakeAstNode<AstNode>({ $type: 'Thing' }))?.LanguageMetaData.languageId).toBe('main');
      });
   });

   describe('setSourceRoot', () => {
      it('stores uri + root + indexes + creates a uri-labelled logger', () => {
         const harness = makeHarness();
         const { state } = createState(harness);
         const root = makeRoot();
         state.setSourceRoot('file:///a.a', root);
         expect(state.sourceUri).toBe('file:///a.a');
         expect(state.sourceRoot).toBe(root);
         expect(state.get<string>(SOURCE_URI_ARG)).toBe('file:///a.a');
         expect(harness.logger.withUris).toContain('file:///a.a');
      });

      it('mirrors uri into the inherited properties map so legacy `state.get(SOURCE_URI_ARG)` callers see it', () => {
         const harness = makeHarness();
         const { state } = createState(harness);
         state.setSourceRoot('file:///x.a', makeRoot());
         expect(state.get<string>(SOURCE_URI_ARG)).toBe('file:///x.a');
      });

      it('captures the text-document version from LangiumDocuments at setSourceRoot time', () => {
         const harness = makeHarness();
         const { state } = createState(harness);
         harness.documents.set('file:///a.a', {
            uri: { toString: () => 'file:///a.a' },
            state: DocumentState.Validated,
            parseResult: { value: makeRoot() },
            textDocument: { version: 7 }
         });
         state.setSourceRoot('file:///a.a', makeRoot());
         expect(state.version).toBe(7);
      });

      it('falls back to version 0 when the document is not in the LangiumDocuments registry', () => {
         const harness = makeHarness();
         const { state } = createState(harness);
         state.setSourceRoot('file:///not-yet-registered.a', makeRoot());
         expect(state.version).toBe(0);
      });

      it('refreshes captured version when setSourceRoot is invoked again after a rebuild', () => {
         const harness = makeHarness();
         const { state } = createState(harness);
         harness.documents.set('file:///a.a', {
            uri: { toString: () => 'file:///a.a' },
            state: DocumentState.Validated,
            parseResult: { value: makeRoot() },
            textDocument: { version: 3 }
         });
         state.setSourceRoot('file:///a.a', makeRoot());
         expect(state.version).toBe(3);
         harness.documents.set('file:///a.a', {
            uri: { toString: () => 'file:///a.a' },
            state: DocumentState.Validated,
            parseResult: { value: makeRoot() },
            textDocument: { version: 4 }
         });
         state.setSourceRoot('file:///a.a', makeRoot());
         expect(state.version).toBe(4);
      });
   });

   describe('refreshSourceRoot', () => {
      it('replaces _sourceRoot when LangiumDocuments returns a different valid root', () => {
         const harness = makeHarness();
         const { state } = createState(harness);
         const r1 = makeRoot('r1');
         state.setSourceRoot('file:///a.a', r1);
         const r2 = makeRoot('r2');
         harness.documents.set('file:///a.a', {
            uri: { toString: () => 'file:///a.a' },
            state: DocumentState.Validated,
            parseResult: { value: r2 }
         });
         state.callRefreshSourceRoot();
         expect(state.sourceRoot).toBe(r2);
      });

      it('keeps the captured root when the document returns the same reference', () => {
         const harness = makeHarness();
         const { state } = createState(harness);
         const r1 = makeRoot('r1');
         state.setSourceRoot('file:///a.a', r1);
         harness.documents.set('file:///a.a', {
            uri: { toString: () => 'file:///a.a' },
            state: DocumentState.Validated,
            parseResult: { value: r1 }
         });
         state.callRefreshSourceRoot();
         expect(state.sourceRoot).toBe(r1);
         // `sourceRoot` alone cannot see the identity short-circuit: re-running
         // setSourceRoot assigns the SAME reference, so the field is identical
         // either way. The re-derived tracer is the observable that is not —
         // an absolute count, one per setSourceRoot call.
         expect(harness.logger.withUris).toEqual(['file:///a.a']);
      });

      it('is a no-op before setSourceRoot has been called', () => {
         const harness = makeHarness();
         const { state } = createState(harness);
         expect(() => state.callRefreshSourceRoot()).not.toThrow();
         // not.toThrow() alone probes nothing here: without the guard the code
         // reaches ModelService.getDocument(undefined), which a Map-backed
         // double answers with `undefined` rather than throwing. The lookup log
         // is what distinguishes "never asked" from "asked and got nothing".
         expect(harness.documentLookups).toEqual([]);
      });
   });

   describe('ready()', () => {
      it('logs a "Wait for state ..." line and resolves when waitForDocumentState resolves', async () => {
         const harness = makeHarness();
         harness.waitForDocumentStatePromise = () => Promise.resolve();
         const { state } = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot());
         await state.ready(DocumentState.Validated);
         expect(harness.logger.timeLabels.some(label => label.includes("Wait for state 'Validated'"))).toBe(true);
      });

      it('runs onReadyRefreshed after the wait — sees the refreshed root', async () => {
         const harness = makeHarness();
         harness.waitForDocumentStatePromise = () => Promise.resolve();
         const { state } = createState(harness);
         const r1 = makeRoot('r1');
         state.setSourceRoot('file:///a.a', r1);
         const r2 = makeRoot('r2');
         harness.documents.set('file:///a.a', {
            uri: { toString: () => 'file:///a.a' },
            state: DocumentState.Validated,
            parseResult: { value: r2 }
         });
         await state.ready(DocumentState.Validated);
         expect(state.sourceRoot).toBe(r2);
      });

      it('throws ModelReadyTimeoutError when the wait exceeds readyTimeoutMs and the doc has not caught up', async () => {
         const harness = makeHarness();
         harness.waitForDocumentStatePromise = () => new Promise(() => undefined);
         const { state } = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot());
         state.setReadyTimeoutMs(10);
         harness.documents.set('file:///a.a', {
            uri: { toString: () => 'file:///a.a' },
            state: DocumentState.Linked,
            parseResult: { value: makeRoot() }
         });
         const pending = state.ready(DocumentState.Validated);
         harness.clock.advance(10);
         await expect(pending).rejects.toBeInstanceOf(ModelReadyTimeoutError);
      });

      it('reports the workspace-relative path and build-status snapshot in the timeout diagnostic', async () => {
         const harness = makeHarness();
         harness.waitForDocumentStatePromise = () => new Promise(() => undefined);
         const { state } = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot());
         state.setReadyTimeoutMs(10);
         harness.documents.set('file:///a.a', {
            uri: { toString: () => 'file:///a.a' },
            state: DocumentState.Linked,
            parseResult: { value: makeRoot() }
         });
         const pending = state.ready(DocumentState.Validated);
         harness.clock.advance(10);
         await expect(pending).rejects.toThrow(/ws\/file:\/\/\/a\.a.*status\[/s);
      });

      it('resolves with a warn when timeout fires but the document already reached the target state (build-phase race)', async () => {
         const harness = makeHarness();
         harness.waitForDocumentStatePromise = () => new Promise(() => undefined);
         const { state } = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot());
         state.setReadyTimeoutMs(10);
         harness.documents.set('file:///a.a', {
            uri: { toString: () => 'file:///a.a' },
            state: DocumentState.Validated,
            parseResult: { value: makeRoot() }
         });
         const pending = state.ready(DocumentState.Validated);
         harness.clock.advance(10);
         await expect(pending).resolves.toBeUndefined();
         expect(harness.logger.warns.some(msg => msg.includes('Missed') && msg.includes('Validated'))).toBe(true);
      });
   });

   describe('updateSourceModel', () => {
      it('subclass impl receives the source-model payload', async () => {
         const harness = makeHarness();
         const { state } = createState(harness);
         await state.updateSourceModel('some-text');
         expect(state.updatedSourceModels).toEqual(['some-text']);
      });

      it('multiple updates are observed in order', async () => {
         const harness = makeHarness();
         const { state } = createState(harness);
         await state.updateSourceModel('first');
         await state.updateSourceModel('second');
         await state.updateSourceModel('third');
         expect(state.updatedSourceModels).toEqual(['first', 'second', 'third']);
      });
   });
});
