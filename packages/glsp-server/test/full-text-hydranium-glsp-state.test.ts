/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { ClientId, type Command, CompoundCommand, GModelIndex, GModelSerializer, ModelState } from '@eclipse-glsp/server';
import 'reflect-metadata';
import { Container, injectable } from 'inversify';
import { type AstNode, type LangiumDocument } from '@hydranium/langium';
import { type ClientSession, DefaultModelLedger, type ServerSharedServices } from '@hydranium/core';
import {
   type BaseVersion,
   asModelVersion,
   ConflictError,
   isDocumentSyntaxError,
   isModelVersion,
   ReconcilingConflictResolver
} from '@hydranium/protocol';
import { makeFakeAstNode, makeStubServiceRegistry } from '@hydranium/core/testing';
import { HydraniumGlspIndex } from '../src/state/hydranium-glsp-index.js';
import { FullTextHydraniumGlspState, type FullTextSourceModel } from '../src/state/full-text-hydranium-glsp-state.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';
import { HydraniumGlspRecordingCommand, type HydraniumGlspRecordingState } from '../src/command/hydranium-glsp-recording-command.js';
import { HydraniumGlspOperationCommand, runOperation } from '../src/command/hydranium-glsp-operation-command.js';

interface TestRoot extends AstNode {
   readonly $type: 'TestRoot';
   readonly label: string;
}

function makeRoot(label = 'r1'): TestRoot {
   return makeFakeAstNode<TestRoot>({ $type: 'TestRoot', label });
}

/** The ledger every test's services share; a root is recorded once, so they never collide. */
const ledger = new DefaultModelLedger();

/** A built root parsed from the text at `version`. */
function parsedAt(version: number): TestRoot {
   const root = makeRoot();
   ledger.record(root, version);
   return root;
}

interface UpdateCall {
   uri: string;
   model: unknown;
   clientId: string;
   baseVersion: BaseVersion;
}

interface Harness {
   readonly updateCalls: UpdateCall[];
   /**
    * Version the fake document store reports, so a base-version assertion can
    * distinguish the CAPTURED version from any other number. With every
    * document at v0 an armed gate and a dropped one differ only by type.
    */
   documentVersion: number;
   serialize: (root: TestRoot) => string | Promise<string>;
   nextUpdatedRoot: TestRoot;
   /**
    * Called by the double's `update`, which the stubbed session's `update`
    * forwards to, with the text it was handed, so a
    * test can model the real round-trip: a write re-parses the document, and the
    * NEXT serialization reflects it. Without that loop the source model looks
    * unchanged after a write, and the recording command's divergence guard
    * correctly refuses to redo.
    */
   onUpdate?: (text: string) => void;
   /** The trivia service the stub language binds; absent unless a test sets one. */
   trivia?: { extract(document: unknown): unknown; apply(text: string, trivia: unknown): string };
   /** The text the store holds; absent unless a test sets one. */
   storeText?: string;
   /** Whether the next update throws a `ConflictError` instead of writing. */
   conflictOnNextUpdate?: boolean;
   /** Whether the last build of the source has a parser error. */
   broken?: boolean;
   /** The debug lines the state logged. */
   readonly debugLines: string[];
}

@injectable()
class TestFullTextState extends FullTextHydraniumGlspState<TestRoot> {}

function makeHarness(): Harness {
   return {
      updateCalls: [],
      debugLines: [],
      documentVersion: 0,
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
      debug: (message: string) => harness.debugLines.push(message),
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
         services: {
            serializer: { Serializer: { serializeAst: (root: TestRoot) => harness.serialize(root) } },
            trivia: {
               get TriviaService(): unknown {
                  return harness.trivia;
               }
            }
         }
      }
   ]);
   const sharedServices = {
      Tracer: { for: () => ({ withUri: () => childLogger }) },
      workspace: {
         TextDocuments: { get: () => (harness.storeText === undefined ? undefined : { getText: () => harness.storeText }) },
         LangiumDocuments: { getDocument: () => undefined },
         ModelLedger: ledger,
         DocumentUriPolicy: { canonicalUri: (uri: string) => uri }
      },
      ServiceRegistry: registry,
      model: {
         ModelService: {
            async update(args: UpdateCall): Promise<{ root: TestRoot }> {
               harness.updateCalls.push(args);
               // As the real gate: only a write gated on a version conflicts, and the error names that version.
               if (harness.conflictOnNextUpdate && isModelVersion(args.baseVersion)) {
                  harness.conflictOnNextUpdate = false;
                  throw new ConflictError(args.uri, args.baseVersion, harness.documentVersion);
               }
               harness.onUpdate?.(args.model as string);
               return { root: harness.nextUpdatedRoot };
            },
            snapshot: (uri: string) => ({ uri, version: harness.documentVersion, root: undefined, diagnostics: [] }),
            getDocument: () => ({
               parseResult: {
                  value: parsedAt(harness.documentVersion),
                  parserErrors: harness.broken ? [{ message: 'broken' }] : [],
                  lexerErrors: []
               },
               textDocument: { getText: () => 'source text' },
               diagnostics: []
            })
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
   const state = container.get(TestFullTextState);
   // The diagram's session is stubbed to record through the service double,
   // stamping its own id, so the recorded calls carry that id.
   state.modelSession = {
      clientId: 'test-client',
      update: (args: object) => sharedServices.model.ModelService.update({ ...args, clientId: 'test-client' } as UpdateCall)
   } as unknown as ClientSession<AstNode>;
   return state;
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
      it('refuses to write without a session, rather than writing under an id it does not hold', async () => {
         const harness = makeHarness();
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));
         state.modelSession = undefined;

         await expect(state.updateSourceModel({ text: 'new document text' })).rejects.toThrow(/No client session/);
         expect(harness.updateCalls).toEqual([]);
      });

      it('pushes the text payload through the diagram session and captures the returned root', async () => {
         const harness = makeHarness();
         harness.nextUpdatedRoot = makeRoot('reparsed');
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', parsedAt(harness.documentVersion));

         await state.updateSourceModel({ text: 'new document text' });

         // No explicit `baseVersion`, so the parameter default applies — and it is the
         // state's own model version rather than `'any'`, which is what makes the
         // gate the thing a caller gets by typing less.
         expect(harness.updateCalls).toEqual([
            { uri: 'file:///a.a', model: 'new document text', clientId: 'test-client', baseVersion: asModelVersion(0) }
         ]);
         expect(state.sourceRoot).toBe(harness.nextUpdatedRoot);
      });

      it('refuses to write text serialized from a root whose source does not parse, with a DocumentSyntaxError', async () => {
         // The storage captures the recovered root once the broken text is built, so text serialized from it lacks what the parser skipped.
         const harness = makeHarness();
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', parsedAt(harness.documentVersion));
         harness.broken = true;

         const refused = await state.updateSourceModel({ text: 'recovered text' }).then(
            () => undefined,
            (error: unknown) => error
         );

         expect({ syntaxError: isDocumentSyntaxError(refused), writes: harness.updateCalls }).toEqual({ syntaxError: true, writes: [] });
      });

      it('takes a conflicting write the text already holds as applied, at the document version it is built to', async () => {
         const harness = makeHarness();
         harness.documentVersion = 4;
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', parsedAt(3));
         harness.storeText = 'new document text';
         harness.conflictOnNextUpdate = true;

         await state.updateSourceModel({ text: 'new document text' }, asModelVersion(3));

         expect({ writes: harness.updateCalls.length, version: state.version }).toEqual({ writes: 1, version: 4 });
         expect(harness.debugLines.filter(line => line.includes('already applied (model v3 / text v4)'))).toHaveLength(1);
      });

      it('throws a conflicting write the text does not hold', async () => {
         const harness = makeHarness();
         harness.documentVersion = 4;
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', parsedAt(3));
         harness.storeText = 'another text';
         harness.conflictOnNextUpdate = true;

         await expect(state.updateSourceModel({ text: 'new document text' }, asModelVersion(3))).rejects.toBeInstanceOf(ConflictError);
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

      it('writes the whole document again on redo', async () => {
         const { harness, setText } = makeTextHarness('element Before {}');
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         const command = recordOver(state, 'Rename element', () => setText('element After {}'));
         await command.execute();
         await command.undo();
         await command.redo();

         expect(harness.updateCalls.map(call => call.model)).toEqual(['element After {}', 'element Before {}', 'element After {}']);
      });

      it('arms the conflict gate with the version taken at execute start', async () => {
         const { harness, setText } = makeTextHarness('element Before {}');
         harness.documentVersion = 7;
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', parsedAt(harness.documentVersion));
         // Advanced AFTER the read. The write must still claim v7, so an
         // assertion on the number cannot be satisfied by a late read.
         harness.documentVersion = 9;

         await recordOver(state, 'Rename element', () => setText('element After {}')).execute();

         expect(harness.updateCalls).toEqual([
            { uri: 'file:///a.a', model: 'element After {}', clientId: 'test-client', baseVersion: asModelVersion(7) }
         ]);
      });

      it('gates an undo on the version of the root the operation wrote, which it resolves the transition onto', async () => {
         const { harness, setText } = makeTextHarness('element Before {}');
         harness.documentVersion = 7;
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', parsedAt(harness.documentVersion));
         harness.nextUpdatedRoot = parsedAt(8);

         const command = recordOver(state, 'Rename element', () => setText('element After {}'));
         await command.execute();
         await command.undo();

         expect(harness.updateCalls.map(call => call.baseVersion)).toEqual([7, 8]);
      });
   });
});

describe('FullTextHydraniumGlspState under an operation', () => {
   it('writes the copy once, gated on the version the operation opened at, and captures the written root when it ends', async () => {
      const harness = makeHarness();
      harness.documentVersion = 3;
      const built = parsedAt(3);
      const state = createState(harness);
      state.setSourceRoot('file:///a.a', built);
      harness.nextUpdatedRoot = parsedAt(5);
      let during: { copy: boolean; writes: number } | undefined;
      const command = new HydraniumGlspRecordingCommand<FullTextSourceModel>(state, 'Edit', () => {
         (state.sourceRoot as { label: string }).label = 'edited';
         during = { copy: state.sourceRoot !== built, writes: harness.updateCalls.length };
      });

      await runOperation(new HydraniumGlspOperationCommand<FullTextSourceModel>(state), () => command);

      expect({
         during,
         writes: harness.updateCalls.map(call => [call.model, call.baseVersion]),
         builtLabel: built.label,
         capturedVersion: state.version
      }).toEqual({
         during: { copy: true, writes: 0 },
         writes: [['serialized:edited', asModelVersion(3)]],
         builtLabel: 'r1',
         capturedVersion: 5
      });
   });
});

describe('FullTextHydraniumGlspState undo', () => {
   it('undoes an operation whose side effect brings the text to the undo result before the write', async () => {
      const harness = makeHarness();
      harness.documentVersion = 3;
      const state = createState(harness);
      state.setSourceRoot('file:///a.a', parsedAt(3));
      const written = makeFakeAstNode<TestRoot>({ $type: 'TestRoot', label: 'edited' });
      ledger.record(written, 5);
      harness.nextUpdatedRoot = written;
      let sideEffects = 0;
      const sideEffect: Command = {
         execute: () => void sideEffects++,
         // As an integrity rule repairing the document on build: the text moves to the undo's result.
         undo: () => {
            sideEffects--;
            harness.documentVersion = 6;
            harness.storeText = 'serialized:r1';
            harness.conflictOnNextUpdate = true;
         },
         redo: () => void sideEffects++
      };
      const operation = new HydraniumGlspOperationCommand<FullTextSourceModel>(state);
      await runOperation(
         operation,
         () =>
            new CompoundCommand([
               new HydraniumGlspRecordingCommand<FullTextSourceModel>(state, 'Edit', () => {
                  (state.sourceRoot as { label: string }).label = 'edited';
               }),
               sideEffect
            ])
      );

      await operation.undo();

      expect({ sideEffects, writes: harness.updateCalls.map(call => call.model), version: state.version }).toEqual({
         sideEffects: 0,
         writes: ['serialized:edited', 'serialized:r1'],
         version: 6
      });
   });
});

describe('FullTextHydraniumGlspState source model', () => {
   it('re-attaches the comments of the document the captured root was parsed from', async () => {
      const harness = makeHarness();
      const document = { uri: 'file:///a.a' };
      const extracted: unknown[] = [];
      harness.trivia = {
         extract: from => {
            extracted.push(from);
            return '// kept';
         },
         apply: (text, trivia) => `${String(trivia)}\n${text}`
      };
      const state = createState(harness);
      state.setSourceRoot(
         'file:///a.a',
         makeFakeAstNode<TestRoot>({ $type: 'TestRoot', label: 'r1', $document: document as unknown as LangiumDocument })
      );

      const model = await state.sourceModel;

      expect({ model, fromDocument: extracted[0] === document }).toEqual({ model: { text: '// kept\nserialized:r1' }, fromDocument: true });
   });
});
