/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Marker, MarkersReason, SetMarkersAction } from '@eclipse-glsp/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
   ActionDispatcher,
   ClientId,
   type ClientSession,
   ClientSessionManager,
   CommandStack,
   GLSPServerError,
   GModelIndex,
   GModelSerializer,
   Logger as GlspLogger,
   ModelState,
   ModelSubmissionHandler,
   RequestModelAction,
   SOURCE_URI_ARG,
   SaveModelAction
} from '@eclipse-glsp/server';
import 'reflect-metadata';
import { Container } from 'inversify';
import { type AstNode } from '@hydranium/langium';
import type { ServerSharedServices } from '@hydranium/core';
import { makeNoopSharedServices, makeNoopTracer } from '@hydranium/core/testing';
import { DefaultMessageRenderer } from '@hydranium/core/messages';
import { type CapturedGlspLine, makeCapturingGlspLogger, makeNoopGlspLogger } from '../src/testing/index.js';
import { HydraniumGlspIndex } from '../src/state/hydranium-glsp-index.js';
import { AbstractHydraniumGlspState } from '../src/state/abstract-hydranium-glsp-state.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';
import { ReconcilingConflictResolver } from '@hydranium/protocol';
import { HydraniumGlspStorage, SOURCE_URI_MISSING } from '../src/storage/hydranium-glsp-storage.js';
import { type SaveConflictPolicy, SaveConflictPolicy as SaveConflictPolicyToken } from '../src/storage/save-conflict-policy.js';

interface TestRoot extends AstNode {
   $type: 'TestRoot';
}

class TestState extends AbstractHydraniumGlspState<TestRoot> {
   async updateSourceModel(_text: string): Promise<void> {
      // no-op: these cases exercise the storage, not the write-back
   }
}

class TestStorage extends HydraniumGlspStorage<TestRoot> {
   public loadCalls: RequestModelAction[] = [];
   public saveCalls: SaveModelAction[] = [];

   override async loadSourceModel(action: RequestModelAction): Promise<void> {
      this.loadCalls.push(action);
   }

   override async saveSourceModel(action: SaveModelAction): Promise<void> {
      this.saveCalls.push(action);
   }

   public callGetSourceUri(action: RequestModelAction): string {
      return this.getSourceUri(action);
   }

   public callGetFileUri(action: SaveModelAction): string {
      return this.getFileUri(action);
   }

   public callToSourceModelUri(sourceUri: string): string {
      return this.toSourceModelUri(sourceUri);
   }

   public pushDisposable(d: { dispose(): void }): void {
      this.toDispose.push(d);
   }
}

interface ListenerHandle {
   listener: ClientSessionListenerLike;
   clientId: string;
}

interface ClientSessionListenerLike {
   sessionDisposed(session: ClientSession): void;
}

interface CapturedSessionManager extends ClientSessionManager {
   readonly handles: ListenerHandle[];
}

function createStorage(
   clientId: string,
   sharedServices: ServerSharedServices = makeNoopSharedServices<ServerSharedServices>()
): { storage: TestStorage; state: TestState; sessions: CapturedSessionManager } {
   const handles: ListenerHandle[] = [];
   const sessions = {
      handles,
      addListener(listener: ClientSessionListenerLike, scopedId: string) {
         handles.push({ listener, clientId: scopedId });
      },
      removeListener() {
         /* no-op for the framework test */
      },
      getSession() {
         return undefined;
      },
      getSessionsByApp() {
         return [];
      },
      disposeSession() {
         /* no-op */
      }
   } as unknown as CapturedSessionManager;

   const container = new Container();
   container.bind(GlspLogger).toConstantValue(makeNoopGlspLogger());
   container.bind(HydraniumTypes.SharedCoreServices).toConstantValue(sharedServices);
   container.bind(HydraniumTypes.Tracer).toConstantValue(makeNoopTracer());
   container.bind(HydraniumTypes.ConflictResolver).toConstantValue(new ReconcilingConflictResolver());
   container.bind(ClientId).toConstantValue(clientId);
   container.bind(ActionDispatcher).toConstantValue({
      dispatch: () => Promise.resolve(),
      dispatchAll: () => Promise.resolve(undefined)
   } as unknown as ActionDispatcher);
   container.bind(ClientSessionManager).toConstantValue(sessions);
   container.bind(ModelSubmissionHandler).toConstantValue({
      hasPendingInitialRequest: () => false,
      submitModel: () => Promise.resolve([])
   } as unknown as ModelSubmissionHandler);
   container.bind(CommandStack).toConstantValue({
      saveIsDone() {
         /* no-op for the framework test */
      }
   } as unknown as CommandStack);
   container.bind(HydraniumGlspIndex).toSelf().inSingletonScope();
   container.bind(GModelIndex).toService(HydraniumGlspIndex);
   container.bind(GModelSerializer).toConstantValue({} as GModelSerializer);
   container.bind(ModelState).to(TestState).inSingletonScope();
   container.bind(TestState).toService(ModelState);
   container.bind(TestStorage).toSelf().inSingletonScope();
   return { storage: container.get(TestStorage), state: container.get(TestState), sessions };
}

/** Records which URIs the storage subscribes to, and which subscriptions it disposes. */
interface SubscriptionLog {
   readonly subscribed: string[];
   readonly disposed: string[];
}

/**
 * Shared services whose `ModelService.onModelUpdated` records the URI instead of
 * subscribing. Only the update subscription is stubbed — the secondary-watch path
 * touches nothing else on the service.
 */
function makeSubscriptionRecordingServices(): { services: ServerSharedServices; log: SubscriptionLog } {
   const log: SubscriptionLog = { subscribed: [], disposed: [] };
   const services = makeNoopSharedServices<ServerSharedServices>({
      model: {
         ModelService: {
            // Read by the state's version capture on every registration; no
            // document exists here, and `undefined` is the same answer a real
            // service gives for an unopened URI.
            getDocument: () => undefined,
            onModelUpdated(uri: string) {
               log.subscribed.push(uri);
               return {
                  dispose() {
                     log.disposed.push(uri);
                  }
               };
            }
         }
      }
   });
   return { services, log };
}

/** Storage that keeps the base {@link HydraniumGlspStorage.saveSourceModel} so the policy branches are exercised. */
class PolicyStorage extends HydraniumGlspStorage<TestRoot> {}

const SAVE_VERSION = 7;

/**
 * Build a {@link PolicyStorage} over a mock `ModelService.save` and a stub state
 * (`clientId`, `sourceRoot`, `version`). Binds {@link SaveConflictPolicyToken}
 * only when a policy is given, so the unbound default path is testable.
 */
function createPolicyStorage(options: { policy?: SaveConflictPolicy; save: (args: unknown) => Promise<unknown> }): {
   storage: PolicyStorage;
   saveMock: ReturnType<typeof vi.fn>;
   root: TestRoot;
   lines: CapturedGlspLine[];
} {
   const root: TestRoot = { $type: 'TestRoot' };
   const saveMock = vi.fn(options.save);
   const { logger, lines } = makeCapturingGlspLogger();
   const container = new Container();
   container.bind(GlspLogger).toConstantValue(logger);
   container
      .bind(HydraniumTypes.SharedCoreServices)
      .toConstantValue(makeNoopSharedServices<ServerSharedServices>({ model: { ModelService: { save: saveMock } } }));
   container.bind(HydraniumTypes.Tracer).toConstantValue(makeNoopTracer());
   container.bind(ClientSessionManager).toConstantValue({
      addListener() {},
      removeListener() {},
      getSession: () => undefined
   } as unknown as ClientSessionManager);
   container.bind(ActionDispatcher).toConstantValue({
      dispatch: () => Promise.resolve(),
      dispatchAll: () => Promise.resolve(undefined)
   } as unknown as ActionDispatcher);
   container.bind(ModelSubmissionHandler).toConstantValue({
      hasPendingInitialRequest: () => false,
      submitModel: () => Promise.resolve([])
   } as unknown as ModelSubmissionHandler);
   container.bind(CommandStack).toConstantValue({ saveIsDone() {} } as unknown as CommandStack);
   container.bind(ModelState).toConstantValue({
      clientId: 'client-1',
      sourceRoot: root,
      version: SAVE_VERSION,
      // Read by `init` to watch the write set. These cases have no secondaries,
      // so the subscription never fires; the slot has to exist all the same.
      onSecondaryUrisChanged: () => ({ dispose() {} })
   } as unknown as ModelState);
   if (options.policy) {
      container.bind(SaveConflictPolicyToken).toConstantValue(options.policy);
   }
   container.bind(PolicyStorage).toSelf().inSingletonScope();
   // `lines` is a live reference — the storage surfaces failures through the
   // GLSP logger after the returned promise settles, so tests filter it at
   // assertion time (a getter would snapshot empty at destructure time).
   return { storage: container.get(PolicyStorage), saveMock, root, lines };
}

const saveAction = { kind: 'saveModel', fileUri: 'file:///x.a' } as unknown as SaveModelAction;

describe('HydraniumGlspStorage', () => {
   describe('init', () => {
      it('registers a session listener under the state.clientId', () => {
         const { storage, sessions } = createStorage('client-1');
         expect(sessions.handles).toHaveLength(1);
         expect(sessions.handles[0].clientId).toBe('client-1');
         expect(sessions.handles[0].listener).toBe(storage);
      });

      it('skips registration for the GLSP tempId placeholder', () => {
         const { sessions } = createStorage('tempId');
         expect(sessions.handles).toHaveLength(0);
      });
   });

   /**
    * The write set is DISCOVERED, not derived: an operation handler identifies the
    * document a node belongs to and registers it mid-operation, nowhere near a
    * capture. These pin that such a document is watched from the moment it joins
    * the set — the alternative, re-deriving the set after each capture, would miss
    * it silently and the diagram would simply never react to that file.
    */
   describe('secondary subscriptions', () => {
      it('subscribes to a secondary registered outside any capture', () => {
         const { services, log } = makeSubscriptionRecordingServices();
         const { state } = createStorage('client-1', services);
         expect(log.subscribed).toEqual([]);

         state.trackSecondaryDocument('file:///a/side.x');

         expect(log.subscribed).toEqual(['file:///a/side.x']);
      });

      it('subscribes once when the same secondary is re-registered', () => {
         // Re-registering refreshes the captured version and is what every
         // setSourceRoot does, so this runs constantly. A reconcile that did not
         // check the map first would stack a second listener on the same document
         // per capture, and the diagram would resubmit once per accumulated
         // listener.
         const { services, log } = makeSubscriptionRecordingServices();
         const { state } = createStorage('client-1', services);

         state.trackSecondaryDocument('file:///a/side.x');
         state.trackSecondaryDocument('file:///a/side.x');

         expect(log.subscribed).toEqual(['file:///a/side.x']);
         expect(log.disposed).toEqual([]);
      });

      it('disposes the subscription of a secondary that leaves the write set', () => {
         const { services, log } = makeSubscriptionRecordingServices();
         const { state } = createStorage('client-1', services);
         state.trackSecondaryDocument('file:///a/side.x');

         state.untrackSecondaryDocuments();

         expect(log.disposed).toEqual(['file:///a/side.x']);
      });

      it('drains every secondary subscription on dispose', () => {
         const { services, log } = makeSubscriptionRecordingServices();
         const { storage, state } = createStorage('client-1', services);
         state.trackSecondaryDocument('file:///a/side.x');
         state.trackSecondaryDocument('file:///a/other.x');

         storage.dispose();

         expect(log.disposed.sort()).toEqual(['file:///a/other.x', 'file:///a/side.x']);
      });

      it('stops reconciling once disposed', () => {
         // dispose() drops the state subscription along with everything else, so a
         // late registration must not resurrect a subscription on a dead storage.
         const { services, log } = makeSubscriptionRecordingServices();
         const { storage, state } = createStorage('client-1', services);
         storage.dispose();

         state.trackSecondaryDocument('file:///a/side.x');

         expect(log.subscribed).toEqual([]);
      });
   });

   describe('getSourceUri', () => {
      it('returns the sourceUri option', () => {
         const { storage } = createStorage('client-1');
         const action = { kind: RequestModelAction.KIND, options: { [SOURCE_URI_ARG]: '/a/b.a' } } as unknown as RequestModelAction;
         expect(storage.callGetSourceUri(action)).toBe('/a/b.a');
      });

      it('throws GLSPServerError when the option is missing', () => {
         const { storage } = createStorage('client-1');
         const action = { kind: RequestModelAction.KIND, options: {} } as unknown as RequestModelAction;
         expect(() => storage.callGetSourceUri(action)).toThrow(GLSPServerError);
      });

      it('throws GLSPServerError when the option is not a string', () => {
         const { storage } = createStorage('client-1');
         const action = { kind: RequestModelAction.KIND, options: { [SOURCE_URI_ARG]: 42 } } as unknown as RequestModelAction;
         expect(() => storage.callGetSourceUri(action)).toThrow(GLSPServerError);
      });

      // Asserting the throw's TYPE passes whatever the text says, so the payload
      // is what matters — and it goes to two readers over two fields. A model
      // request carries a request id, so upstream takes `detail` from
      // `cause?.toString?.()`: a single-argument throw reaches neither the client
      // nor the log, both printing `undefined`. Hence the cause is asserted, not
      // just the message.
      it('addresses the user in the message and names the missing argument in the cause', () => {
         const { storage } = createStorage('client-1');
         const action = { kind: RequestModelAction.KIND, options: {} } as unknown as RequestModelAction;
         let thrown: unknown;
         try {
            storage.callGetSourceUri(action);
         } catch (error: unknown) {
            thrown = error;
         }
         if (!(thrown instanceof GLSPServerError)) {
            throw new Error('expected getSourceUri to throw a GLSPServerError');
         }
         expect(thrown.message).toBe(SOURCE_URI_MISSING.text);
         // The developer half, which is what upstream projects into `detail`.
         expect(thrown.cause).toBeDefined();
         expect(String(thrown.cause)).toContain(SOURCE_URI_ARG);
         expect(String(thrown.cause)).toContain(RequestModelAction.KIND);
      });
   });

   /**
    * GLSP's action protocol has no slot for a message identity anywhere, so the
    * raise site renders. These assert on the thrown `message`, which is what
    * upstream turns into the toast (no request id) or the reject `detail` (with
    * one) — the only channel either string reaches a user through.
    */
   describe('server-side rendering of a GLSP message', () => {
      const GLSP_CATALOGUE = { [SOURCE_URI_MISSING.code]: 'AA: kein Dokument' };

      class GlspCatalogueRenderer extends DefaultMessageRenderer {
         protected override translationsFor(locale: string | undefined): Record<string, string> | undefined {
            return locale === 'xx-AA' ? GLSP_CATALOGUE : undefined;
         }
      }

      /** A tree whose renderer serves {@link GLSP_CATALOGUE} at `locale`. */
      function servicesWithLocale(locale: string | undefined): ServerSharedServices {
         const services = makeNoopSharedServices<ServerSharedServices>({
            MessageRenderer: shared => new GlspCatalogueRenderer(shared)
         });
         if (locale) {
            services.ServerLocale.accept(locale);
         }
         return services;
      }

      /** The `GLSPServerError` a source-URI-less model request throws. */
      function thrownError(services: ServerSharedServices): GLSPServerError {
         const { storage } = createStorage('client-1', services);
         const action = { kind: RequestModelAction.KIND, options: {} } as unknown as RequestModelAction;
         try {
            storage.callGetSourceUri(action);
         } catch (error: unknown) {
            if (error instanceof GLSPServerError) {
               return error;
            }
         }
         throw new Error('expected getSourceUri to throw a GLSPServerError');
      }

      it('renders the message in the installed locale', () => {
         expect(thrownError(servicesWithLocale('xx-AA')).message).toBe('AA: kein Dokument');
      });

      it('sends the English when no locale matches — the control on the row above', () => {
         // Same renderer, no locale: without this the assertion above would pass
         // against a renderer that was never consulted.
         expect(thrownError(servicesWithLocale(undefined)).message).toBe(SOURCE_URI_MISSING.text);
      });

      it('leaves the cause untranslated, its content being developer-addressed', () => {
         // An AUDIENCE call, not a reachability one. On this path the cause does
         // reach only logs (`RejectAction.detail` is read by nothing but the
         // upstream client's action-dispatcher `logger.warn`), but the save path
         // routes it into `MessageAction.details`, which a Theia host shows to a
         // user behind a "Show details" button. What keeps it English is that it
         // names the action kind and the missing option: a translated developer
         // string is the worse outcome.
         const error = thrownError(servicesWithLocale('xx-AA'));

         expect(String(error.cause)).toContain(SOURCE_URI_ARG);
         expect(String(error.cause)).toContain(RequestModelAction.KIND);
         expect(String(error.cause)).not.toContain('AA:');
      });
   });

   /** Both upstream GLSP integrations are represented: one sends a path, the other a URI string. */
   describe('toSourceModelUri', () => {
      it('parses a URI string rather than treating it as a path', () => {
         const { storage } = createStorage('client-1');
         expect(storage.callToSourceModelUri('file:///a/b.x')).toBe('file:///a/b.x');
      });

      it('converts a POSIX path to a file URI', () => {
         const { storage } = createStorage('client-1');
         expect(storage.callToSourceModelUri('/a/b.x')).toBe('file:///a/b.x');
      });

      it('treats a Windows drive letter as a path, not as a one-character scheme', () => {
         // `URI.parse('C:/a/b.x')` yields scheme `C` and round-trips unchanged,
         // so a naive scheme test silently passes a non-URI through. Asserting
         // the `file:` prefix is what distinguishes the two paths here; the
         // encoded drive letter is left unasserted because `URI.file` encodes it
         // differently by platform.
         const { storage } = createStorage('client-1');
         expect(storage.callToSourceModelUri('C:/a/b.x').startsWith('file://')).toBe(true);
      });
   });

   describe('getFileUri', () => {
      it('returns SaveModelAction.fileUri when provided', () => {
         const { storage } = createStorage('client-1');
         const action = { kind: SaveModelAction.KIND, fileUri: '/a/saved.a' } as unknown as SaveModelAction;
         expect(storage.callGetFileUri(action)).toBe('/a/saved.a');
      });

      it('falls back to state.get(SOURCE_URI_ARG) when fileUri is missing', () => {
         const { storage } = createStorage('client-1');
         (storage as unknown as { state: AbstractHydraniumGlspState<TestRoot> }).state.set(SOURCE_URI_ARG, '/a/from-state.a');
         const action = { kind: SaveModelAction.KIND } as unknown as SaveModelAction;
         expect(storage.callGetFileUri(action)).toBe('/a/from-state.a');
      });

      it('throws GLSPServerError when neither is available', () => {
         const { storage } = createStorage('client-1');
         const action = { kind: SaveModelAction.KIND } as unknown as SaveModelAction;
         expect(() => storage.callGetFileUri(action)).toThrow(GLSPServerError);
      });

      // The throw above reaches a user as a toast built from `message`, with
      // `cause` behind the details control, so the two carry different audiences
      // and asserting the error TYPE cannot tell them apart.
      it('addresses the user in the message and names the empty lookups in the cause', () => {
         const { storage } = createStorage('client-1');
         const action = { kind: SaveModelAction.KIND } as unknown as SaveModelAction;
         let thrown: unknown;
         try {
            storage.callGetFileUri(action);
         } catch (error: unknown) {
            thrown = error;
         }
         expect(thrown).toBeInstanceOf(GLSPServerError);
         const failure = thrown as GLSPServerError;
         expect(failure.message).toBe('Could not determine where to save this model');
         expect(String(failure.cause)).toContain(SOURCE_URI_ARG);
         expect(String(failure.cause)).toContain('client-1');
      });
   });

   describe('refreshDiagnosticMarkers', () => {
      it('dispatches the bound validator markers as a SetMarkersAction (reason batch)', async () => {
         const { storage } = createStorage('client-1');
         const marker: Marker = { elementId: 'e1', kind: 'error', label: 'dup', description: 'dup' };
         const dispatch = vi.fn();
         (storage as unknown as { modelValidator: unknown }).modelValidator = { validate: () => [marker] };
         (storage as unknown as { actionDispatcher: unknown }).actionDispatcher = { dispatch };

         await storage.refreshDiagnosticMarkers();

         expect(dispatch).toHaveBeenCalledTimes(1);
         const action = dispatch.mock.calls[0][0] as SetMarkersAction;
         expect(SetMarkersAction.is(action)).toBe(true);
         expect(action.markers).toEqual([marker]);
         expect(action.reason).toBe(MarkersReason.BATCH);
      });

      it('dispatches an empty marker set to clear when the model is valid', async () => {
         const { storage } = createStorage('client-1');
         const dispatch = vi.fn();
         (storage as unknown as { modelValidator: unknown }).modelValidator = { validate: () => [] };
         (storage as unknown as { actionDispatcher: unknown }).actionDispatcher = { dispatch };

         await storage.refreshDiagnosticMarkers();

         expect((dispatch.mock.calls[0][0] as SetMarkersAction).markers).toEqual([]);
      });

      it('is a no-op when no validator is bound', async () => {
         const { storage } = createStorage('client-1');
         const dispatch = vi.fn();
         (storage as unknown as { actionDispatcher: unknown }).actionDispatcher = { dispatch };

         await storage.refreshDiagnosticMarkers();

         expect(dispatch).not.toHaveBeenCalled();
      });
   });

   describe('saveSourceModel — conflict policy', () => {
      it('defaults to overwrite (no baseVersion, awaits) when no policy is bound', async () => {
         const { storage, saveMock, root } = createPolicyStorage({ save: () => Promise.resolve() });
         const result = storage.saveSourceModel(saveAction);
         expect(result).toBeInstanceOf(Promise);
         await result;
         expect(saveMock).toHaveBeenCalledTimes(1);
         expect(saveMock.mock.calls[0][0]).toEqual({ uri: 'file:///x.a', model: root, clientId: 'client-1', baseVersion: undefined });
      });

      it('reject guards on the captured version and propagates the failure', async () => {
         const conflict = new Error('stale');
         const { storage, saveMock } = createPolicyStorage({ policy: { kind: 'reject' }, save: () => Promise.reject(conflict) });
         const result = storage.saveSourceModel(saveAction);
         await expect(result).rejects.toBe(conflict);
         expect(saveMock.mock.calls[0][0]).toMatchObject({ baseVersion: SAVE_VERSION });
      });

      it('drop-and-log guards, fires-and-forgets (returns undefined), and swallows + logs failures', async () => {
         const { storage, saveMock, lines } = createPolicyStorage({
            policy: { kind: 'drop-and-log' },
            save: () => Promise.reject(new Error('stale'))
         });
         const result = storage.saveSourceModel(saveAction);
         expect(result).toBeUndefined();
         expect(saveMock.mock.calls[0][0]).toMatchObject({ baseVersion: SAVE_VERSION });
         // Let the rejected save settle; it must be caught + logged, never rethrown.
         await Promise.resolve();
         await Promise.resolve();
         expect(lines.some(line => line.level === 'error' && line.message.includes('Save failed for file:///x.a'))).toBe(true);
      });
   });

   describe('dispose lifecycle', () => {
      it('drains toDispose on dispose()', () => {
         const { storage } = createStorage('client-1');
         let disposed = 0;
         storage.pushDisposable({ dispose: () => (disposed += 1) });
         storage.dispose();
         expect(disposed).toBe(1);
      });

      it('drains via sessionDisposed too', () => {
         const { storage } = createStorage('client-1');
         let disposed = 0;
         storage.pushDisposable({ dispose: () => (disposed += 1) });
         storage.sessionDisposed({ id: 'client-1' } as ClientSession);
         expect(disposed).toBe(1);
      });

      it('is idempotent across repeated dispose() calls', () => {
         const { storage } = createStorage('client-1');
         let disposed = 0;
         storage.pushDisposable({ dispose: () => (disposed += 1) });
         storage.dispose();
         storage.dispose();
         expect(disposed).toBe(1);
      });
   });
});
