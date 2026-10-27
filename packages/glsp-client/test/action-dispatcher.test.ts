/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
   type Action,
   type RequestAction,
   type ResponseAction,
   CheckEdgeResultAction,
   ComputedBoundsAction,
   Deferred as GlspDeferred,
   GLSPActionDispatcher,
   LogLevel,
   MessageAction,
   RedoAction,
   RejectAction,
   RequestBoundsAction,
   RequestCheckEdgeAction,
   RequestContextActions,
   RequestModelAction,
   RequestTypeHintsAction,
   SetDirtyStateAction,
   SetEditModeAction,
   SetMarkersAction,
   SetModelAction,
   SetTypeHintsAction,
   StatusAction,
   UndoAction
} from '@eclipse-glsp/client';
import { Deferred, EditsSettledAction, RequestEditsSettledAction, SaveFailedError, isSaveFailedError } from '@hydranium/protocol';
import { makeFakeClock, tick, waitFor } from '@hydranium/protocol/testing';
import { HYDRANIUM_DEFAULT_KIND_PAIRS, HYDRANIUM_DEFAULT_LOGGED_KINDS, HydraniumGlspActionDispatcher } from '../src/action-dispatcher';

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
   exposeLogAction(action: Action): void {
      this.logAction(action);
   }
   setActionHandlerRegistry(registry: unknown): void {
      (this as unknown as { actionHandlerRegistry: unknown }).actionHandlerRegistry = registry;
   }
   setTracer(tracer: unknown): void {
      (this as unknown as { tracer: unknown }).tracer = tracer;
   }
   setLogger(logger: unknown): void {
      (this as unknown as { hydraniumLogger: unknown }).hydraniumLogger = logger;
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
      const logger = { error: vi.fn() };
      dispatcher.setLogger(logger);
      dispatcher.setTracer({
         time: () => {
            throw new Error('stale tracer API');
         }
      });
      expect(() => dispatcher.exposeRegisterInitTiming()).not.toThrow();
      expect(logger.error).toHaveBeenCalledWith('Failed to register model-initialized timing instrumentation', expect.any(Error));
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

   it('an edge check summarises its edge type, source and target, and its result the verdict too', () => {
      const check = {
         kind: RequestCheckEdgeAction.KIND,
         requestId: 'r1',
         edgeType: 'edge:one',
         sourceElementId: 'a',
         targetElementId: 'b'
      };
      expect(dispatcher.exposeSummarize(asAction(check))).toBe('edgeType=edge:one source=a target=b');
      expect(dispatcher.exposeSummarize(asAction({ ...check, targetElementId: undefined }))).toBe('edgeType=edge:one source=a target=none');
      expect(
         dispatcher.exposeSummarize(
            asAction({
               kind: CheckEdgeResultAction.KIND,
               responseId: 'r1',
               isValid: false,
               edgeType: 'edge:one',
               sourceElementId: 'a',
               targetElementId: 'b'
            })
         )
      ).toBe('edgeType=edge:one source=a target=b isValid=false');
   });

   it('unknown action kinds summarise to empty string', () => {
      expect(dispatcher.exposeSummarize({ kind: 'unknown-action' })).toBe('');
   });
});

/** A dispatcher whose host asked for edits in flight to be counted. */
class TrackingDispatcher extends TestableDispatcher {
   protected override readonly trackEditsInFlight = true;
   protected override readonly settleEditsMs = 50;

   /** Lift a block with `unblocking`, over `postponed`, through sprotty's own handleBlocked. */
   liftBlock(unblocking: Action, postponed: Action[]): Promise<void> {
      this.postponedActions = postponed.map(action => ({ action, resolve: () => undefined, reject: () => undefined }));
      return this.handleBlocked(unblocking, () => true);
   }

   // Stubbed: the block's own action needs a full GLSP container to handle.
   protected override handleAction(): Promise<void> {
      return Promise.resolve();
   }
}

const defaultBoundClock = makeFakeClock();

/** Counts edits with the default bound on the wait, on a clock the test advances. */
class DefaultBoundDispatcher extends TestableDispatcher {
   protected override readonly trackEditsInFlight = true;
   protected override readonly clock = defaultBoundClock;
}

describe('HydraniumGlspActionDispatcher edits in flight', () => {
   /** What reached GLSP's dispatcher and its request, in order. */
   let sent: string[];
   /** The settle requests not yet answered, oldest first. */
   let settles: Array<Deferred<Action>>;
   let dispatcher: TrackingDispatcher;
   const operation = asAction({ kind: 'changeBounds', isOperation: true, newBounds: [] });

   function serve(...kinds: string[]): void {
      dispatcher.setActionHandlerRegistry({ get: (kind: string) => (kinds.includes(kind) ? [{}] : []) });
   }

   beforeEach(() => {
      sent = [];
      settles = [];
      dispatcher = new TrackingDispatcher();
      dispatcher.setLogger({ trace: vi.fn() });
      serve(RequestEditsSettledAction.KIND);
      vi.spyOn(GLSPActionDispatcher.prototype, 'dispatch').mockImplementation(async (action: Action) => {
         sent.push(action.kind);
      });
      vi.spyOn(dispatcher, 'request').mockImplementation(<Res extends ResponseAction>(action: RequestAction<Res>) => {
         sent.push(action.kind);
         const settle = new Deferred<Action>();
         settles.push(settle);
         return settle.promise as Promise<Res>;
      });
   });

   afterEach(() => {
      vi.restoreAllMocks();
   });

   it('counts an operation from its send until the server answers the settle request sent after it', async () => {
      await dispatcher.dispatch(operation);
      expect(sent).toEqual(['changeBounds', RequestEditsSettledAction.KIND]);
      expect(dispatcher.editsInFlight).toBe(1);

      settles[0].resolve(EditsSettledAction.create());
      await waitFor(() => dispatcher.editsInFlight === 0);
   });

   it('counts undo and redo, which change the model on the server too', async () => {
      await dispatcher.dispatch(UndoAction.create());
      await dispatcher.dispatch(RedoAction.create());
      expect(dispatcher.editsInFlight).toBe(2);
   });

   it('counts each edit until its own settle is answered', async () => {
      await dispatcher.dispatch(operation);
      await dispatcher.dispatch({ ...operation });
      settles[0].resolve(EditsSettledAction.create());
      await tick();
      expect(dispatcher.editsInFlight).toBe(1);
   });

   it('counts an edit once when a lifted block dispatches it a second time', async () => {
      await dispatcher.dispatch(operation);
      await dispatcher.liftBlock(asAction({ kind: 'setModel', newRoot: { type: 'graph', id: 'g' } }), [operation]);
      expect(dispatcher.editsInFlight).toBe(1);
      expect(sent).toEqual(['changeBounds', RequestEditsSettledAction.KIND, 'changeBounds']);
   });

   it('keeps counting an edit whose settle request failed to send, which sprotty leaves unanswered', async () => {
      vi.mocked(dispatcher.request).mockRestore();
      let failedSends = 0;
      vi.spyOn(GLSPActionDispatcher.prototype, 'dispatch').mockImplementation(async (action: Action) => {
         if (action.kind === RequestEditsSettledAction.KIND) {
            failedSends++;
            throw new Error('connection closed');
         }
      });
      await dispatcher.dispatch(operation);
      await tick();
      expect(failedSends).toBe(1);
      expect(dispatcher.editsInFlight).toBe(1);
   });

   it('ends the count of every earlier edit once a later settle is answered, since the server handles them in order', async () => {
      await dispatcher.dispatch(operation);
      await dispatcher.dispatch({ ...operation });
      expect(dispatcher.editsInFlight).toBe(2);

      // The first settle stays unanswered, as one whose send failed would.
      settles[1].resolve(EditsSettledAction.create());
      await waitFor(() => dispatcher.editsInFlight === 0);
      await expect(dispatcher.whenEditsSettled()).resolves.toBe(true);
   });

   it('counts an edit object each time a caller dispatches it again, whether its last edit is in flight or answered', async () => {
      await dispatcher.dispatch(operation);
      await dispatcher.dispatch(operation);
      expect(dispatcher.editsInFlight).toBe(2);

      settles[0].resolve(EditsSettledAction.create());
      settles[1].resolve(EditsSettledAction.create());
      await waitFor(() => dispatcher.editsInFlight === 0);
      await dispatcher.dispatch(operation);
      expect(dispatcher.editsInFlight).toBe(1);
   });

   it('does not count an action that is no edit, nor an operation that came from the server', async () => {
      await dispatcher.dispatch(asAction({ kind: 'setModel', newRoot: { type: 'graph', id: 'g' } }));
      await dispatcher.dispatch(asAction({ ...operation, __receivedFromServer: true }));
      expect(dispatcher.editsInFlight).toBe(0);
      expect(sent).not.toContain(RequestEditsSettledAction.KIND);
   });

   it('ends the count when the server rejects the settle request', async () => {
      await dispatcher.dispatch(operation);
      settles[0].reject(new Error('rejected'));
      await waitFor(() => dispatcher.editsInFlight === 0);
   });

   it('keeps counting while the settle request has no answer, so a guard asks rather than loses the edit', async () => {
      await dispatcher.dispatch(operation);
      await tick();
      expect(dispatcher.editsInFlight).toBe(1);
   });

   it('waits for the edits in flight when asked to, and reports them settled though an edit sent after is not', async () => {
      await dispatcher.dispatch(operation);
      let settled = false;
      const waiting = dispatcher.whenEditsSettled().then(result => {
         settled = true;
         return result;
      });
      await dispatcher.dispatch({ ...operation });
      await tick();
      expect(settled).toBe(false);

      settles[0].resolve(EditsSettledAction.create());
      await expect(waiting).resolves.toBe(true);
      expect(dispatcher.editsInFlight).toBe(1);
   });

   it('reports the wait unsettled once its bound passes while an edit stays unanswered, which still counts', async () => {
      await dispatcher.dispatch(operation);
      await expect(dispatcher.whenEditsSettled()).resolves.toBe(false);
      expect(dispatcher.editsInFlight).toBe(1);
   });

   it("waits by default well past the server's bounded waits on one settle before reporting an edit unsettled", async () => {
      const slow = new DefaultBoundDispatcher();
      slow.setLogger({ trace: vi.fn() });
      slow.setActionHandlerRegistry({ get: (kind: string) => (kind === RequestEditsSettledAction.KIND ? [{}] : []) });
      vi.spyOn(slow, 'request').mockImplementation(<Res extends ResponseAction>() => new Deferred<Res>().promise);
      await slow.dispatch(operation);
      let settled: boolean | undefined;
      void slow.whenEditsSettled().then(result => (settled = result));

      // Past the server's two bounded waits together, with room for its own handling.
      defaultBoundClock.advance(29_000);
      await tick(5);
      expect(settled).toBeUndefined();
      defaultBoundClock.advance(1_000);
      await waitFor(() => settled !== undefined);
      expect(settled).toBe(false);
   });

   it('reports no edits in flight as settled at once', async () => {
      await expect(dispatcher.whenEditsSettled()).resolves.toBe(true);
   });

   it('counts an edit whose own send failed until the settle request after it is answered', async () => {
      vi.mocked(GLSPActionDispatcher.prototype.dispatch).mockImplementationOnce(async (action: Action) => {
         sent.push(action.kind);
         throw new Error('send failed');
      });
      await expect(dispatcher.dispatch(operation)).rejects.toThrow('send failed');
      expect(dispatcher.editsInFlight).toBe(1);
      settles[0].resolve(EditsSettledAction.create());
      await waitFor(() => dispatcher.editsInFlight === 0);
   });

   it('counts nothing and asks the server nothing when the host did not ask for edits to be counted', async () => {
      const untracked = new TestableDispatcher();
      untracked.setLogger({ trace: vi.fn() });
      untracked.setActionHandlerRegistry({ get: (kind: string) => (kind === RequestEditsSettledAction.KIND ? [{}] : []) });
      const request = vi.spyOn(untracked, 'request');
      await untracked.dispatch(operation);
      expect(untracked.editsInFlight).toBe(0);
      expect(request).not.toHaveBeenCalled();
   });

   it('counts nothing against a server that serves no settle request, which nothing would answer', async () => {
      serve();
      await dispatcher.dispatch(operation);
      expect(dispatcher.editsInFlight).toBe(0);
      expect(sent).toEqual(['changeBounds']);
   });
});

describe('HydraniumGlspActionDispatcher logging an edge check', () => {
   it('logs the check and its verdict as one timed request and response', () => {
      const dispatcher = new TestableDispatcher();
      const logger = { trace: vi.fn() };
      dispatcher.setLogger(logger);
      dispatcher.setActionHandlerRegistry({ get: () => [] });
      const check = asAction({
         kind: RequestCheckEdgeAction.KIND,
         requestId: 'r1',
         edgeType: 'edge:one',
         sourceElementId: 'a',
         targetElementId: 'b'
      });
      const result = asAction({
         kind: CheckEdgeResultAction.KIND,
         responseId: 'r1',
         isValid: false,
         edgeType: 'edge:one',
         sourceElementId: 'a',
         targetElementId: 'b'
      });

      expect(dispatcher.exposeLoggedKinds().has(check.kind)).toBe(true);
      expect(dispatcher.exposeLoggedKinds().has(result.kind)).toBe(true);
      dispatcher.exposeLogAction(check);
      dispatcher.exposeLogAction(result);

      const lines = logger.trace.mock.calls.map(([line]) => String(line));
      expect(lines[0]).toMatch(
         /^Process action 'requestCheckEdge' \[client → client] \[edgeType=edge:one source=a target=b] \[request #1]$/
      );
      expect(lines[1]).toMatch(
         /^Process action 'checkEdgeTargetResult' \[client → client] \[edgeType=edge:one source=a target=b isValid=false] \[response #1, \d+ms]$/
      );
   });
});

/** Answers a request it registered itself, past GLSP's dispatch pipeline. */
class AnsweringDispatcher extends TestableDispatcher {
   constructor() {
      super();
      this.logger = { logLevel: LogLevel.warn, error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() };
   }

   awaitResponse(requestId: string): Promise<ResponseAction> {
      const pending = new GlspDeferred<ResponseAction>();
      this.requests.set(requestId, pending);
      return pending.promise;
   }

   respond(action: ResponseAction): Promise<void> {
      return this.handleResponseAction(action);
   }

   /** A request timeout as `requestUntil` arms it, `true` while it is still armed. */
   armTimeout(requestId: string): () => boolean {
      const timer = setTimeout(() => undefined, 60_000);
      this.timeouts.set(requestId, timer);
      return () => this.timeouts.has(requestId);
   }
}

describe('HydraniumGlspActionDispatcher rejected requests', () => {
   function dispatcherWithRequest(): { dispatcher: AnsweringDispatcher; response: Promise<ResponseAction> } {
      const dispatcher = new AnsweringDispatcher();
      return { dispatcher, response: dispatcher.awaitResponse('save-1') };
   }

   it('rejects with the typed error a reject carries in its detail', async () => {
      const { dispatcher, response } = dispatcherWithRequest();
      const error = new SaveFailedError([{ uri: 'file:///x.a', reason: 'disk full' }]);
      await dispatcher.respond(
         RejectAction.create('Failed to handle request', { responseId: 'save-1', detail: JSON.stringify(error.toJson()) })
      );

      const rejection = await response.then(
         () => undefined,
         (reason: unknown) => reason
      );
      expect(isSaveFailedError(rejection)).toBe(true);
      expect(rejection).toMatchObject({ failures: [{ uri: 'file:///x.a', reason: 'disk full' }] });
   });

   it('clears the request timeout when it rejects with a typed error', async () => {
      const { dispatcher, response } = dispatcherWithRequest();
      const armed = dispatcher.armTimeout('save-1');
      const detail = JSON.stringify(new SaveFailedError([{ uri: 'file:///x.a', reason: 'disk full' }]).toJson());
      await dispatcher.respond(RejectAction.create('Failed to handle request', { responseId: 'save-1', detail }));
      await response.catch(() => undefined);
      expect(armed()).toBe(false);
   });

   it("rejects with GLSP's message when the detail is plain text", async () => {
      const { dispatcher, response } = dispatcherWithRequest();
      await dispatcher.respond(RejectAction.create('Failed to handle request', { responseId: 'save-1', detail: 'Error: plain failure' }));
      await expect(response).rejects.toThrow('Failed to handle request');
   });
});

// The handleResponseAction override repeats GLSP's timeout and request
// handling, so a GLSP release that changes it would silently not apply.
describe('GLSPActionDispatcher.handleResponseAction', () => {
   it('still matches the body HydraniumGlspActionDispatcher repeats', () => {
      const body = GLSPActionDispatcher.prototype['handleResponseAction'].toString().replace(/\s+/g, ' ').trim();
      expect(
         createHash('sha256').update(body).digest('hex'),
         "@eclipse-glsp/client changed GLSPActionDispatcher.handleResponseAction: re-align HydraniumGlspActionDispatcher's override and update this digest"
      ).toBe('7442551c620d679cdb62db18799ac0e9d9e0d194873ae8f8f638b9e4fa1df043');
   });
});
