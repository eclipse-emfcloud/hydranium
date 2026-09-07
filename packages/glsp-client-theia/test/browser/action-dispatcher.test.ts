/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The SUT injects `ChannelLogger` from `@hydranium/client-theia/browser`, whose real
// module loads `@theia/output` → `@theia/monaco` → `@lumino/widgets` (DOM globals at
// module load, unavailable in the node test env). The dispatcher tests never resolve a
// container, so a bare token stand-in is enough.
vi.mock('@hydranium/client-theia/lib/browser', () => ({
   ChannelLogger: class ChannelLogger {},
   ChannelTracer: Symbol('ChannelTracer')
}));

import { describe, expect, it, vi } from 'vitest';
import {
   type Action,
   ComputedBoundsAction,
   MessageAction,
   RejectAction,
   RequestBoundsAction,
   RequestContextActions,
   RequestModelAction,
   RequestTypeHintsAction,
   SetDirtyStateAction,
   SetEditModeAction,
   SetMarkersAction,
   SetModelAction,
   SetTypeHintsAction,
   StatusAction
} from '@eclipse-glsp/client';
import {
   HYDRANIUM_DEFAULT_KIND_PAIRS,
   HYDRANIUM_DEFAULT_LOGGED_KINDS,
   HydraniumGlspActionDispatcher
} from '../../src/browser/action-dispatcher';

// Test subclass exposes protected members for assertion + skips the inherited
// initialise pipeline (which needs a full GLSP container).
class TestableDispatcher extends HydraniumGlspActionDispatcher {
   exposeLoggedKinds(): ReadonlySet<string> {
      return this.loggedKinds;
   }
   exposeKindPairs(): ReadonlyMap<string, string> {
      return this.kindPairs;
   }
   exposeKindPairsReverse(): ReadonlyMap<string, string> {
      return this.kindPairsReverse;
   }
   exposeTrackPair(action: Action): string {
      return this.trackPair(action);
   }
   exposeSummarize(action: Action): string {
      return this.summarize(action);
   }
   exposeRegisterInitTiming(): void {
      this.registerInitTiming();
   }
   setTracer(tracer: unknown): void {
      (this as unknown as { tracer: unknown }).tracer = tracer;
   }
   setChannel(channel: unknown): void {
      (this as unknown as { channel: unknown }).channel = channel;
   }
}

/** Helper: cast partial action shapes through Action without TS complaining
 *  about extra properties. The SUT narrows via `.is(...)` typeguards at runtime. */
const asAction = (partial: object): Action => partial as Action;

describe('HydraniumGlspActionDispatcher defaults', () => {
   it('loggedKinds covers every kind in the lifted default set', () => {
      const dispatcher = new TestableDispatcher();
      // Spot-check several standard kinds, plus the cardinality of the default set.
      expect(dispatcher.exposeLoggedKinds().has(SetModelAction.KIND)).toBe(true);
      expect(dispatcher.exposeLoggedKinds().has(RequestBoundsAction.KIND)).toBe(true);
      expect(dispatcher.exposeLoggedKinds().has(StatusAction.KIND)).toBe(true);
      expect(dispatcher.exposeLoggedKinds().size).toBe(HYDRANIUM_DEFAULT_LOGGED_KINDS.size);
   });

   it('kindPairs maps RequestModelAction → SetModelAction (and others) by default', () => {
      const dispatcher = new TestableDispatcher();
      expect(dispatcher.exposeKindPairs().get(RequestModelAction.KIND)).toBe(SetModelAction.KIND);
      expect(dispatcher.exposeKindPairs().get(RequestBoundsAction.KIND)).toBe(ComputedBoundsAction.KIND);
      expect(dispatcher.exposeKindPairs().get(RequestTypeHintsAction.KIND)).toBe(SetTypeHintsAction.KIND);
      expect(dispatcher.exposeKindPairs().size).toBe(HYDRANIUM_DEFAULT_KIND_PAIRS.size);
   });

   it('kindPairsReverse mirrors kindPairs', () => {
      const dispatcher = new TestableDispatcher();
      expect(dispatcher.exposeKindPairsReverse().get(SetModelAction.KIND)).toBe(RequestModelAction.KIND);
      expect(dispatcher.exposeKindPairsReverse().get(ComputedBoundsAction.KIND)).toBe(RequestBoundsAction.KIND);
   });
});

describe('HydraniumGlspActionDispatcher extra-options', () => {
   it('extraLoggedKinds add to the default set without removing defaults', () => {
      const dispatcher = new TestableDispatcher({ extraLoggedKinds: ['my-custom-kind'] });
      expect(dispatcher.exposeLoggedKinds().has(SetModelAction.KIND)).toBe(true);
      expect(dispatcher.exposeLoggedKinds().has('my-custom-kind')).toBe(true);
   });

   it('extraKindPairs add to the default map and reverse-map matches', () => {
      const dispatcher = new TestableDispatcher({ extraKindPairs: [['req-x', 'resp-x']] });
      expect(dispatcher.exposeKindPairs().get('req-x')).toBe('resp-x');
      expect(dispatcher.exposeKindPairsReverse().get('resp-x')).toBe('req-x');
      // Defaults still present:
      expect(dispatcher.exposeKindPairs().get(RequestModelAction.KIND)).toBe(SetModelAction.KIND);
   });

   it('options.summarize replaces the framework summarize when provided', () => {
      const dispatcher = new TestableDispatcher({ summarize: () => 'forced' });
      // The replacement runs for every action kind, including ones the default
      // would return '' for, so we can verify by passing an arbitrary action.
      expect(dispatcher.exposeSummarize({ kind: 'whatever' })).toBe('forced');
   });
});

describe('HydraniumGlspActionDispatcher.registerInitTiming', () => {
   it('registers the timing line via the tracer on a healthy tracer', () => {
      const dispatcher = new TestableDispatcher();
      const time = vi.fn();
      dispatcher.setTracer({ time });
      dispatcher.exposeRegisterInitTiming();
      expect(time).toHaveBeenCalledWith('Model initialized', expect.any(Function), 'info', { logAfterMs: 0 });
   });

   it('swallows + logs a tracer failure so instrumentation cannot abort diagram init', () => {
      const dispatcher = new TestableDispatcher();
      const channel = { error: vi.fn() };
      dispatcher.setChannel(channel);
      dispatcher.setTracer({
         time: () => {
            throw new Error('stale tracer API');
         }
      });
      expect(() => dispatcher.exposeRegisterInitTiming()).not.toThrow();
      expect(channel.error).toHaveBeenCalledWith('Failed to register model-initialized timing instrumentation', expect.any(Error));
   });
});

describe('HydraniumGlspActionDispatcher.trackPair', () => {
   it('emits [request #N] then [response #N, Xms] for id-based request/response pairs', () => {
      const dispatcher = new TestableDispatcher();
      const request = asAction({ kind: RequestContextActions.KIND, requestId: 'r1', contextId: 'menu' });
      const first = dispatcher.exposeTrackPair(request);
      expect(first).toBe('[request #1]');
      const response = asAction({ kind: 'someResponse', responseId: 'r1' });
      const second = dispatcher.exposeTrackPair(response);
      expect(second).toMatch(/^\[response #1, \d+ms]$/);
   });

   it('matches kind-pair FIFO requests/responses without requestId', () => {
      const dispatcher = new TestableDispatcher();
      // RequestModelAction → SetModelAction is a default kind-pair.
      const request = { kind: RequestModelAction.KIND };
      expect(dispatcher.exposeTrackPair(request)).toBe('[request #1]');
      const response = { kind: SetModelAction.KIND };
      expect(dispatcher.exposeTrackPair(response)).toMatch(/^\[response #1, \d+ms]$/);
   });

   it('queues multiple in-flight kind-pair requests FIFO', () => {
      const dispatcher = new TestableDispatcher();
      expect(dispatcher.exposeTrackPair({ kind: RequestModelAction.KIND })).toBe('[request #1]');
      expect(dispatcher.exposeTrackPair({ kind: RequestModelAction.KIND })).toBe('[request #2]');
      expect(dispatcher.exposeTrackPair({ kind: SetModelAction.KIND })).toMatch(/^\[response #1,/);
      expect(dispatcher.exposeTrackPair({ kind: SetModelAction.KIND })).toMatch(/^\[response #2,/);
   });

   it('returns empty for unrelated actions', () => {
      const dispatcher = new TestableDispatcher();
      expect(dispatcher.exposeTrackPair({ kind: 'some-other-action' })).toBe('');
   });

   it('id-based match wins over kind-pair fallback when both could apply', () => {
      const dispatcher = new TestableDispatcher();
      const request = asAction({ kind: RequestModelAction.KIND, requestId: 'rid-1' });
      expect(dispatcher.exposeTrackPair(request)).toBe('[request #1]');
      // Response carries the responseId AND is the kind-pair response kind. Id
      // match consumes the entry; the kind-pair queue stays empty.
      const response = asAction({ kind: SetModelAction.KIND, responseId: 'rid-1' });
      expect(dispatcher.exposeTrackPair(response)).toMatch(/^\[response #1,/);
      // A subsequent kind-pair-only response finds nothing to match.
      const orphan = { kind: SetModelAction.KIND };
      expect(dispatcher.exposeTrackPair(orphan)).toBe('');
   });
});

describe('HydraniumGlspActionDispatcher.summarize defaults', () => {
   const dispatcher = new TestableDispatcher();

   it('SetModelAction summarises rootType + child count', () => {
      const action = asAction({
         kind: SetModelAction.KIND,
         newRoot: { type: 'graph', children: [{}, {}] }
      });
      expect(dispatcher.exposeSummarize(action)).toBe('rootType=graph children=2');
   });

   it('RequestBoundsAction summarises rootType + child count', () => {
      // RequestBoundsAction.is requires `requestId` (RequestAction parent typeguard).
      const action = asAction({ kind: RequestBoundsAction.KIND, requestId: '', newRoot: { type: 'graph', children: [{}] } });
      expect(dispatcher.exposeSummarize(action)).toBe('rootType=graph children=1');
   });

   it('ComputedBoundsAction summarises the bounds count', () => {
      const action = asAction({ kind: ComputedBoundsAction.KIND, bounds: [{}, {}, {}] });
      expect(dispatcher.exposeSummarize(action)).toBe('bounds=3');
   });

   it('SetDirtyStateAction summarises dirty flag + reason', () => {
      expect(dispatcher.exposeSummarize(asAction({ kind: SetDirtyStateAction.KIND, isDirty: true, reason: 'edit' }))).toBe(
         'isDirty=true reason=edit'
      );
      expect(dispatcher.exposeSummarize(asAction({ kind: SetDirtyStateAction.KIND, isDirty: false }))).toBe('isDirty=false reason=n/a');
   });

   it('SetEditModeAction summarises the new mode', () => {
      expect(dispatcher.exposeSummarize(asAction({ kind: SetEditModeAction.KIND, editMode: 'readonly' }))).toBe('editMode=readonly');
   });

   it('SetMarkersAction summarises the marker count', () => {
      expect(dispatcher.exposeSummarize(asAction({ kind: SetMarkersAction.KIND, markers: [{}, {}] }))).toBe('markers=2');
   });

   it('StatusAction (clear) annotates the empty message', () => {
      expect(dispatcher.exposeSummarize(asAction({ kind: StatusAction.KIND, severity: 'NONE', message: '' }))).toBe(
         'severity=NONE message="" (clear)'
      );
   });

   it('MessageAction summarises severity + truncated message', () => {
      const long = 'x'.repeat(200);
      const summary = dispatcher.exposeSummarize(asAction({ kind: MessageAction.KIND, severity: 'INFO', message: long }));
      expect(summary).toMatch(/^severity=INFO message="x{160}"$/);
   });

   it('RejectAction summarises the rejection reason (truncated)', () => {
      expect(dispatcher.exposeSummarize(asAction({ kind: RejectAction.KIND, message: 'boom' }))).toBe('reason="boom"');
   });

   it('SetTypeHintsAction summarises shapes + edges counts', () => {
      expect(dispatcher.exposeSummarize(asAction({ kind: SetTypeHintsAction.KIND, shapeHints: [{}, {}], edgeHints: [{}] }))).toBe(
         'shapes=2 edges=1'
      );
   });

   it('RequestContextActions summarises the context id', () => {
      // RequestContextActions.is requires kind + requestId + contextId + editorContext object.
      expect(
         dispatcher.exposeSummarize(
            asAction({
               kind: RequestContextActions.KIND,
               requestId: '',
               contextId: 'menu',
               editorContext: { selectedElementIds: [] }
            })
         )
      ).toBe('contextId=menu');
   });

   it('Unknown action kinds summarise to empty string', () => {
      expect(dispatcher.exposeSummarize({ kind: 'unknown-action' })).toBe('');
   });
});
