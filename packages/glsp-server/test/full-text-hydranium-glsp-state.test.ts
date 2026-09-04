/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { ClientId, GModelIndex, GModelSerializer, ModelState } from '@eclipse-glsp/server';
import 'reflect-metadata';
import { Container, injectable } from 'inversify';
import { type AstNode } from '@hydranium/langium';
import type { ServerSharedServices } from '@hydranium/core';
import { ReconcilingConflictResolver } from '@hydranium/protocol';
import { makeFakeAstNode, makeStubServiceRegistry } from '@hydranium/core/testing';
import { HydraniumGlspIndex } from '../src/state/hydranium-glsp-index.js';
import { FullTextHydraniumGlspState, type FullTextSourceModel } from '../src/state/full-text-hydranium-glsp-state.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';
import { HydraniumGlspRecordingCommand, type HydraniumGlspRecordingState } from '../src/command/hydranium-glsp-recording-command.js';

interface TestRoot extends AstNode {
   readonly $type: 'TestRoot';
   readonly label: string;
}

function makeRoot(label = 'r1'): TestRoot {
   return makeFakeAstNode<TestRoot>({ $type: 'TestRoot', label });
}

interface UpdateCall {
   uri: string;
   model: unknown;
   clientId: string;
}

interface Harness {
   readonly updateCalls: UpdateCall[];
   serialize: (root: TestRoot) => string | Promise<string>;
   nextUpdatedRoot: TestRoot;
   /**
    * Called by the fake `ModelService.update` with the text it was handed, so a
    * test can model the real round-trip: a write re-parses the document, and the
    * NEXT serialization reflects it. Without that loop the source model looks
    * unchanged after a write, and the recording command's divergence guard
    * correctly refuses to redo.
    */
   onUpdate?: (text: string) => void;
}

@injectable()
class TestFullTextState extends FullTextHydraniumGlspState<TestRoot> {}

function makeHarness(): Harness {
   return {
      updateCalls: [],
      serialize: root => `serialized:${root.label}`,
      nextUpdatedRoot: makeRoot('persisted')
   };
}

function createState(harness: Harness): TestFullTextState {
   // Self-returning `for` / `withUri`, because a real `Tracer` is-a Logger AND a
   // factory: `AbstractHydraniumGlspState.logger` returns `this.tracer`, so a
   // consumer reaching for `logger.for(...)` — as the recording command does —
   // hits this object rather than the outer `Tracer`. A stub missing `for` fails
   // only once something composes over the state, which is why it went unnoticed
   // while every case called a seam directly.
   const childLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      for: (): unknown => childLogger,
      withUri: (): unknown => childLogger,
      async time<T>(_label: string, callback: () => Promise<T> | T): Promise<T> {
         return await callback();
      }
   };
   // The framework's real registry carrying one stub language, so it keeps
   // every lookup path the code under test reaches for rather than the one a
   // hand-rolled object happens to declare.
   const registry = makeStubServiceRegistry([
      {
         languageId: 'test',
         fileExtensions: ['.a'],
         services: { serializer: { Serializer: { serializeAst: (root: TestRoot) => harness.serialize(root) } } }
      }
   ]);
   const sharedServices = {
      Tracer: { for: () => ({ withUri: () => childLogger }) },
      workspace: { LangiumDocuments: { getDocument: () => undefined } },
      ServiceRegistry: registry,
      model: {
         ModelService: {
            async update(args: UpdateCall): Promise<{ root: TestRoot }> {
               harness.updateCalls.push(args);
               harness.onUpdate?.(args.model as string);
               return { root: harness.nextUpdatedRoot };
            },
            getDocument: () => undefined
         }
      }
   };
   const container = new Container();
   container.bind(HydraniumTypes.SharedCoreServices).toConstantValue(sharedServices as unknown as ServerSharedServices);
   container.bind(HydraniumTypes.Tracer).toConstantValue({ withUri: () => childLogger } as never);
   container.bind(HydraniumTypes.ConflictResolver).toConstantValue(new ReconcilingConflictResolver());
   container.bind(HydraniumGlspIndex).toSelf().inSingletonScope();
   container.bind(GModelSerializer).toConstantValue({} as GModelSerializer);
   container.bind(GModelIndex).toService(HydraniumGlspIndex);
   container.bind(ClientId).toConstantValue('test-client');
   container.bind(ModelState).to(TestFullTextState).inSingletonScope();
   container.bind(TestFullTextState).toService(ModelState);
   return container.get(TestFullTextState);
}

describe('FullTextHydraniumGlspState', () => {
   describe('sourceModel', () => {
      it('serialises the source root to text via the per-URI serializer', () => {
         const state = createState(makeHarness());
         state.setSourceRoot('file:///a.a', makeRoot('Alpha'));
         expect(state.sourceModel).toEqual({ text: 'serialized:Alpha' });
      });

      it('resolves an async serializer to a text source model', async () => {
         const harness = makeHarness();
         harness.serialize = root => Promise.resolve(`async:${root.label}`);
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('Beta'));
         await expect(state.sourceModel).resolves.toEqual({ text: 'async:Beta' });
      });
   });

   describe('updateSourceModel', () => {
      it('pushes the text payload through ModelService.update and captures the returned root', async () => {
         const harness = makeHarness();
         harness.nextUpdatedRoot = makeRoot('reparsed');
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         await state.updateSourceModel({ text: 'new document text' });

         expect(harness.updateCalls).toEqual([{ uri: 'file:///a.a', model: 'new document text', clientId: 'test-client' }]);
         expect(state.sourceRoot).toBe(harness.nextUpdatedRoot);
      });
   });

   /**
    * The STRATEGY rather than the class: this state driven by a real
    * {@link HydraniumGlspRecordingCommand}, the composition it exists inside.
    * The cases above call each seam directly, which leaves the whole-document
    * patch SHAPE unasserted.
    *
    * The shape is the point, and it is why this state cannot field-merge: a
    * whole-document source model has exactly ONE field, so the recorded patch
    * is a single `replace /text` and undo rewrites the entire document rather
    * than reverting one property.
    *
    * The serializer must be SYNCHRONOUS here: `JsonRecordingCommand.getJsonObject`
    * reads `modelState.sourceModel` without awaiting, and this state's getter is
    * `MaybePromise`. An async serializer under a recording command would diff a
    * Promise — worth knowing, and out of scope for this suite.
    */
   describe('through the real recording command', () => {
      /** Serialized text as a closure variable, so `doExecute` can model an in-place AST mutation. */
      function makeTextHarness(initial: string): { harness: Harness; setText: (next: string) => void } {
         let text = initial;
         const harness = makeHarness();
         harness.serialize = () => text;
         // The write→re-parse→re-serialize loop a real ModelService closes.
         harness.onUpdate = written => (text = written);
         return { harness, setText: next => (text = next) };
      }

      function recordOver(state: TestFullTextState, label: string, mutate: () => void): HydraniumGlspRecordingCommand<FullTextSourceModel> {
         return new HydraniumGlspRecordingCommand<FullTextSourceModel>(
            state as unknown as HydraniumGlspRecordingState<FullTextSourceModel>,
            label,
            mutate
         );
      }

      it('records a whole-document patch, so undo rewrites the entire text', async () => {
         const { harness, setText } = makeTextHarness('element Before {}');
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         const command = recordOver(state, 'Rename element', () => setText('element After {}'));
         await command.execute();

         // The forward write carries the whole new document, not a field edit.
         expect(harness.updateCalls.map(call => call.model)).toEqual(['element After {}']);

         await command.undo();

         // And undo carries the whole ORIGINAL document back. A field-merging
         // state would have written a property here; this one cannot, which is
         // exactly the documented limitation.
         expect(harness.updateCalls.map(call => call.model)).toEqual(['element After {}', 'element Before {}']);
      });

      it('replays the whole document on redo', async () => {
         const { harness, setText } = makeTextHarness('element Before {}');
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         const command = recordOver(state, 'Rename element', () => setText('element After {}'));
         await command.execute();
         await command.undo();
         await command.redo();

         expect(harness.updateCalls.map(call => call.model)).toEqual(['element After {}', 'element Before {}', 'element After {}']);
      });

      it('drops the based-on version, so the full-text path never arms the conflict gate', async () => {
         const { harness, setText } = makeTextHarness('element Before {}');
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         await recordOver(state, 'Rename element', () => setText('element After {}')).execute();

         // `AbstractHydraniumGlspState.updateSourceModel` is `(model, version?)`
         // and the command threads the version captured at execute start — but
         // this state overrides with a one-parameter signature, so the version is
         // dropped and `ModelService.update` is called without one. The
         // consequence is the class's stated design: no `ConflictError` gate, so
         // concurrent edits degrade to drop-on-divergence rather than merging.
         expect(harness.updateCalls).toEqual([{ uri: 'file:///a.a', model: 'element After {}', clientId: 'test-client' }]);
      });
   });
});
