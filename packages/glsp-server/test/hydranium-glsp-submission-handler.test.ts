/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it, vi } from 'vitest';
import {
   type Action,
   type DirtyStateChangeReason,
   type GModelRoot,
   type GModelRootSchema,
   LayoutOperation,
   ModelSubmissionHandler,
   type SetModelAction
} from '@eclipse-glsp/server';
import 'reflect-metadata';
import { type AstNode, DocumentState } from '@hydranium/langium';
import { HydraniumGlspSubmissionHandler } from '../src/submission/hydranium-glsp-submission-handler.js';

/**
 * Spy-target surfaces that narrow GLSP's `MaybePromise<Action[]>` return type and surface
 * the protected `createSetModeAction` for `vi.spyOn` overload resolution. Cast through
 * these aliases only — keeps the test free of `as never` mock-return ceremony.
 */
type ParentSubmitSurface = {
   submitModel(reason?: DirtyStateChangeReason, layout?: LayoutOperation): Promise<Action[]>;
};
type ParentProtoSurface = {
   createSetModeAction(root: GModelRootSchema): SetModelAction;
};

interface TestRoot extends AstNode {
   readonly $type: 'TestRoot';
   readonly label?: string;
}

interface InfoLog {
   readonly messages: string[];
}

interface FakeState {
   sourceRoot: TestRoot | undefined;
   root: GModelRoot | undefined;
   readyCalls: DocumentState[];
   readonly logger: { info(msg: string): void };
   ready(state: DocumentState): Promise<void>;
}

function makeState(infoLog: InfoLog): FakeState {
   const state: FakeState = {
      sourceRoot: undefined,
      root: undefined,
      readyCalls: [],
      logger: {
         info(msg: string): void {
            infoLog.messages.push(msg);
         }
      },
      async ready(documentState: DocumentState): Promise<void> {
         state.readyCalls.push(documentState);
      }
   };
   return state;
}

class TestSubmissionHandler extends HydraniumGlspSubmissionHandler<TestRoot> {
   // Test seam: surface protected request-tracking field so initial-request guard cases work.
   setRequestModelActionForTest(value: unknown): void {
      (this as unknown as { requestModelAction?: unknown }).requestModelAction = value;
   }

   setReadyEventForTest(value: DocumentState | undefined): void {
      this.readyEvent = value;
   }
}

class CustomDescribingSubmissionHandler extends HydraniumGlspSubmissionHandler<TestRoot> {
   protected override formatSourceRoot(root: TestRoot | undefined): string {
      return root ? `TestRoot label=${root.label ?? '?'}` : 'no-root';
   }
}

function bindFakeState<T extends HydraniumGlspSubmissionHandler<TestRoot>>(handler: T, fake: FakeState): T {
   (handler as unknown as { modelState: FakeState }).modelState = fake;
   return handler;
}

describe('HydraniumGlspSubmissionHandler', () => {
   describe('hasPendingInitialRequest', () => {
      it('returns false when no RequestModelAction is in flight', () => {
         const handler = new TestSubmissionHandler();
         bindFakeState(handler, makeState({ messages: [] }));
         expect(handler.hasPendingInitialRequest()).toBe(false);
      });

      it('returns true once a RequestModelAction has been captured', () => {
         const handler = new TestSubmissionHandler();
         bindFakeState(handler, makeState({ messages: [] }));
         handler.setRequestModelActionForTest({ kind: 'requestModel' });
         expect(handler.hasPendingInitialRequest()).toBe(true);
      });
   });

   describe('submitModel ready-gate', () => {
      it('skips state.ready when readyEvent is undefined', async () => {
         const log: InfoLog = { messages: [] };
         const state = makeState(log);
         state.sourceRoot = { $type: 'TestRoot' };
         const handler = bindFakeState(new TestSubmissionHandler(), state);
         // Framework default is `IntegrityService.SettledState`; opt out explicitly
         // to exercise the no-wait branch.
         handler.setReadyEventForTest(undefined);

         const parentSpy = vi
            .spyOn(ModelSubmissionHandler.prototype as unknown as ParentSubmitSurface, 'submitModel')
            .mockResolvedValue([{ kind: 'setModel' } as Action]);

         try {
            await handler.submitModel();
            expect(state.readyCalls).toHaveLength(0);
            expect(parentSpy).toHaveBeenCalledWith(undefined, undefined);
         } finally {
            parentSpy.mockRestore();
         }
      });

      it('awaits state.ready(readyEvent) before delegating to super.submitModel', async () => {
         const log: InfoLog = { messages: [] };
         const state = makeState(log);
         state.sourceRoot = { $type: 'TestRoot' };
         const order: string[] = [];
         state.ready = async (documentState: DocumentState) => {
            order.push(`ready(${DocumentState[documentState]})`);
            state.readyCalls.push(documentState);
         };
         const handler = bindFakeState(new TestSubmissionHandler(), state);
         handler.setReadyEventForTest(DocumentState.IndexedReferences);

         const parentSpy = vi
            .spyOn(ModelSubmissionHandler.prototype as unknown as ParentSubmitSurface, 'submitModel')
            .mockImplementation(async () => {
               order.push('super.submitModel');
               return [{ kind: 'setModel' } as Action];
            });

         try {
            await handler.submitModel('operation');
            expect(state.readyCalls).toEqual([DocumentState.IndexedReferences]);
            expect(order).toEqual(['ready(IndexedReferences)', 'super.submitModel']);
            expect(parentSpy).toHaveBeenCalledWith('operation', undefined);
         } finally {
            parentSpy.mockRestore();
         }
      });

      it('passes both reason and layout through to super.submitModel', async () => {
         const log: InfoLog = { messages: [] };
         const state = makeState(log);
         state.sourceRoot = { $type: 'TestRoot' };
         const handler = bindFakeState(new TestSubmissionHandler(), state);

         const layout = { kind: LayoutOperation.KIND } as LayoutOperation;
         const parentSpy = vi
            .spyOn(ModelSubmissionHandler.prototype as unknown as ParentSubmitSurface, 'submitModel')
            .mockResolvedValue([{ kind: 'setModel' } as Action]);

         try {
            await handler.submitModel('operation', layout);
            expect(parentSpy).toHaveBeenCalledWith('operation', layout);
         } finally {
            parentSpy.mockRestore();
         }
      });
   });

   describe('logSubmit', () => {
      it('emits a Submit-model line with default formatSourceRoot returning $type', async () => {
         const log: InfoLog = { messages: [] };
         const state = makeState(log);
         state.sourceRoot = { $type: 'TestRoot', label: 'L' };
         state.root = { type: 'graph', children: [{ id: 'n1' }, { id: 'n2' }] } as unknown as GModelRoot;
         const handler = bindFakeState(new TestSubmissionHandler(), state);

         const parentSpy = vi
            .spyOn(ModelSubmissionHandler.prototype as unknown as ParentSubmitSurface, 'submitModel')
            .mockResolvedValue([{ kind: 'setModel' } as Action, { kind: 'requestBounds' } as Action]);

         try {
            await handler.submitModel('operation');
            const line = log.messages.find(m => m.startsWith('Submit model'));
            expect(line).toBeDefined();
            expect(line).toContain('reason=operation');
            expect(line).toContain('actions=[setModel,requestBounds]');
            expect(line).toContain('gmodel={type=graph, children=2}');
            expect(line).toContain('ast={TestRoot}');
         } finally {
            parentSpy.mockRestore();
         }
      });

      it('uses an overridden formatSourceRoot from a subclass', async () => {
         const log: InfoLog = { messages: [] };
         const state = makeState(log);
         state.sourceRoot = { $type: 'TestRoot', label: 'hello' };
         state.root = { type: 'graph', children: [] } as unknown as GModelRoot;
         const handler = bindFakeState(new CustomDescribingSubmissionHandler(), state);

         const parentSpy = vi
            .spyOn(ModelSubmissionHandler.prototype as unknown as ParentSubmitSurface, 'submitModel')
            .mockResolvedValue([{ kind: 'setModel' } as Action]);

         try {
            await handler.submitModel();
            const line = log.messages.find(m => m.startsWith('Submit model'));
            expect(line).toContain('ast={TestRoot label=hello}');
            expect(line).toContain('reason=initial');
         } finally {
            parentSpy.mockRestore();
         }
      });

      it('reports ast=none when the source root is undefined', async () => {
         const log: InfoLog = { messages: [] };
         const state = makeState(log);
         state.sourceRoot = undefined;
         state.root = undefined;
         const handler = bindFakeState(new TestSubmissionHandler(), state);

         const parentSpy = vi
            .spyOn(ModelSubmissionHandler.prototype as unknown as ParentSubmitSurface, 'submitModel')
            .mockResolvedValue([]);

         try {
            await handler.submitModel();
            const line = log.messages.find(m => m.startsWith('Submit model'));
            expect(line).toContain('ast={none}');
            expect(line).toContain('gmodel={type=none, children=0}');
            expect(line).toContain('actions=[]');
         } finally {
            parentSpy.mockRestore();
         }
      });
   });

   describe('createSetModeAction', () => {
      it('logs the responseId and returns the action from super', () => {
         const log: InfoLog = { messages: [] };
         const state = makeState(log);
         const handler = bindFakeState(new TestSubmissionHandler(), state);

         const setModelAction = { kind: 'setModel', responseId: 'rq-7' } as unknown as SetModelAction;
         const parentSpy = vi
            .spyOn(ModelSubmissionHandler.prototype as unknown as ParentProtoSurface, 'createSetModeAction')
            .mockReturnValue(setModelAction);

         try {
            const out = (
               handler as unknown as {
                  createSetModeAction(root: GModelRootSchema): SetModelAction;
               }
            ).createSetModeAction({} as GModelRootSchema);
            expect(out).toBe(setModelAction);
            const line = log.messages.find(m => m.startsWith('Dispatching SetModelAction'));
            expect(line).toContain('requestModel #rq-7');
            expect(line).toContain('initial model handshake complete');
         } finally {
            parentSpy.mockRestore();
         }
      });

      it("substitutes '?' when responseId is missing", () => {
         const log: InfoLog = { messages: [] };
         const state = makeState(log);
         const handler = bindFakeState(new TestSubmissionHandler(), state);

         const setModelAction = { kind: 'setModel' } as unknown as SetModelAction;
         const parentSpy = vi
            .spyOn(ModelSubmissionHandler.prototype as unknown as ParentProtoSurface, 'createSetModeAction')
            .mockReturnValue(setModelAction);

         try {
            (
               handler as unknown as {
                  createSetModeAction(root: GModelRootSchema): SetModelAction;
               }
            ).createSetModeAction({} as GModelRootSchema);
            const line = log.messages.find(m => m.startsWith('Dispatching SetModelAction'));
            expect(line).toContain('requestModel #?');
         } finally {
            parentSpy.mockRestore();
         }
      });
   });
});
