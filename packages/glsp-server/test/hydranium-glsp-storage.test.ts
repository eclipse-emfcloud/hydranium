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
import type { ClientSession as ModelClientSession, ServerSharedServices } from '@hydranium/core';
import { makeNoopSharedServices, makeNoopTracer } from '@hydranium/core/testing';
import { DefaultMessageRenderer } from '@hydranium/core/messages';
import { type CapturedGlspLine, makeCapturingGlspLogger, makeNoopGlspLogger } from '../src/testing/index.js';
import { HydraniumGlspIndex } from '../src/state/hydranium-glsp-index.js';
import { AbstractHydraniumGlspState } from '../src/state/abstract-hydranium-glsp-state.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';
import { DuplicateClientIdError, ReconcilingConflictResolver, SessionClosedError } from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/testing';
import { DIAGRAM_SESSION_REFUSED, HydraniumGlspStorage, SOURCE_URI_MISSING } from '../src/storage/hydranium-glsp-storage.js';
import { type SaveDeliveryPolicy, SaveDeliveryPolicy as SaveDeliveryPolicyToken } from '../src/storage/save-delivery-policy.js';

interface TestRoot extends AstNode {
   $type: 'TestRoot';
}

class TestState extends AbstractHydraniumGlspState<TestRoot> {
   async updateSourceModel(_text: string): Promise<void> {
      // no-op: these cases exercise the storage, not the write-back
   }
}

class TestStorage extends HydraniumGlspStorage<TestRoot> {
   protected override readonly sessionWaitMs = 50;
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

   public callFlushWriteSet(primaryUri: string): Promise<void> {
      return this.flushWriteSet(primaryUri);
   }

   public callRequireModelSession(): ModelClientSession<AstNode> {
      return this.requireModelSession();
   }

   public callAwaitModelSession(): Promise<ModelClientSession<AstNode>> {
      return this.awaitModelSession();
   }
}

/** The diagram's client session as the storage sees it: records what it is asked to do into `calls`, and fails every open with `openError`. */
function makeRecordingModelSession(clientId: string, calls: string[], openError?: Error): ModelClientSession<AstNode> {
   const session = {
      clientId,
      label: 'diagram',
      async open(uri: string): Promise<void> {
         calls.push(`open ${uri}`);
         if (openError) {
            throw openError;
         }
      },
      async close(uri: string): Promise<void> {
         calls.push(`close ${uri}`);
      },
      dispose(): void {
         calls.push('dispose');
      }
   };
   return session as unknown as ModelClientSession<AstNode>;
}

/**
 * A `ModelService` double that hands out recording sessions from
 * `createSession`, recording each call as `createSession <label> <id>`, or
 * refuses the id when `refuse` is set. `documents` are the URIs `getDocument`
 * knows.
 */
function makeSessionModelService(
   options: { calls?: string[]; refuse?: boolean; documents?: readonly string[]; openError?: Error } = {}
): object {
   const calls = options.calls ?? [];
   return {
      snapshot: () => undefined,
      getDocument: (uri: string) => (options.documents?.includes(uri) ? { uri } : undefined),
      createSession(label: string, clientId: string): ModelClientSession<AstNode> {
         calls.push(`createSession ${label} ${clientId}`);
         if (options.refuse) {
            throw new DuplicateClientIdError(clientId);
         }
         return makeRecordingModelSession(clientId, calls, options.openError);
      }
   };
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
   sharedServices: ServerSharedServices = makeNoopSharedServices<ServerSharedServices>({
      model: { ModelService: makeSessionModelService() }
   }),
   logger: GlspLogger = makeNoopGlspLogger()
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
   container.bind(GlspLogger).toConstantValue(logger);
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
            ...makeSessionModelService(),
            // Read by the state's version capture on every registration; no
            // document exists here, and `undefined` is the same answer a real
            // service gives for an unopened URI.
            snapshot: () => undefined,
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

/**
 * Build a {@link PolicyStorage} over a mock `AstDocumentManager.save` and a stub
 * state (`clientId`, `sourceRoot`, `secondaryUris`). Binds
 * {@link SaveDeliveryPolicyToken} only when a policy is given, so the unbound
 * default path is testable.
 *
 * `openUris` are the documents the diagram's session has open, which is what
 * the flush saves; `openElsewhere` are open only in another client.
 *
 * Whether a save reaches disk is `AstDocumentManager.save`'s own decision and is
 * covered where that lives; mocking it here leaves these cases about the write
 * SET — which URIs the flush names, in what order, and how many times.
 */
function createPolicyStorage(options: {
   policy?: SaveDeliveryPolicy;
   save: (uri: string, clientId: string) => Promise<unknown>;
   secondaryUris?: readonly string[];
   openUris?: readonly string[];
   openElsewhere?: readonly string[];
   refuseSession?: boolean;
}): {
   storage: PolicyStorage;
   saveMock: ReturnType<typeof vi.fn>;
   root: TestRoot;
   lines: CapturedGlspLine[];
} {
   const root: TestRoot = { $type: 'TestRoot' };
   const saveMock = vi.fn(options.save);
   const open = new Set(options.openUris ?? ['file:///x.a', ...(options.secondaryUris ?? [])]);
   const openElsewhere = new Set(options.openElsewhere ?? []);
   const { logger, lines } = makeCapturingGlspLogger();
   const container = new Container();
   container.bind(GlspLogger).toConstantValue(logger);
   container.bind(HydraniumTypes.SharedCoreServices).toConstantValue(
      makeNoopSharedServices<ServerSharedServices>({
         workspace: {
            AstDocumentManager: { save: saveMock, isOpen: (uri: string) => open.has(uri) || openElsewhere.has(uri) },
            TextDocuments: {
               isOpenInClient: (uri: string, clientId: string) => (clientId === 'client-1' ? open : openElsewhere).has(uri)
            }
         },
         model: { ModelService: makeSessionModelService({ refuse: options.refuseSession }) }
      })
   );
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
      secondaryUris: options.secondaryUris ?? [],
      // Read by `init` to watch the write set; the subscription never fires in
      // these cases, but the slot has to exist all the same.
      onSecondaryUrisChanged: () => ({ dispose() {} })
   } as unknown as ModelState);
   if (options.policy) {
      container.bind(SaveDeliveryPolicyToken).toConstantValue(options.policy);
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
         const calls: string[] = [];
         const { sessions, state } = createStorage(
            'tempId',
            makeNoopSharedServices<ServerSharedServices>({ model: { ModelService: makeSessionModelService({ calls }) } })
         );
         expect(sessions.handles).toHaveLength(0);
         // A throwaway container GLSP builds only to enumerate action kinds:
         // registering its id would hold the placeholder until the process ends.
         expect(calls).toEqual([]);
         expect(state.modelSession).toBeUndefined();
      });

      it('registers the GLSP client id as a client session and hands it to the state', () => {
         const calls: string[] = [];
         const { state } = createStorage(
            'client-1',
            makeNoopSharedServices<ServerSharedServices>({ model: { ModelService: makeSessionModelService({ calls }) } })
         );
         expect(calls).toEqual(['createSession diagram client-1']);
         expect(state.modelSession?.clientId).toBe('client-1');
      });

      it('registers no session for an id another participant holds, and refuses to load', () => {
         const { storage, state } = createStorage(
            'client-1',
            makeNoopSharedServices<ServerSharedServices>({ model: { ModelService: makeSessionModelService({ refuse: true }) } })
         );
         expect(state.modelSession).toBeUndefined();
         expect(() => storage.callRequireModelSession()).toThrow(
            expect.objectContaining({ message: DIAGRAM_SESSION_REFUSED.text, cause: expect.stringContaining('client-1') })
         );
      });
   });

   describe('a refused client id', () => {
      it('registers the session once the id frees, when it is next needed', () => {
         const options = { refuse: true };
         const { storage, state } = createStorage(
            'client-1',
            makeNoopSharedServices<ServerSharedServices>({ model: { ModelService: makeSessionModelService(options) } })
         );
         expect(state.modelSession).toBeUndefined();

         options.refuse = false;

         expect(storage.callRequireModelSession().clientId).toBe('client-1');
         expect(state.modelSession?.clientId).toBe('client-1');
      });
   });

   /**
    * A document that joins the write set is opened through the diagram's
    * session, and stays open until the diagram's next save after it left: the
    * diagram's unsaved edits to it are not reverted by leaving.
    */
   describe('write-set opens', () => {
      /** A storage whose session records into `calls`, over a store knowing `documents`, open for the diagram as `open`. */
      function createOpeningStorage(
         documents: readonly string[],
         open: Set<string>,
         options: { onSave?: (uri: string) => Promise<void>; openError?: Error; logger?: GlspLogger } = {}
      ): { storage: TestStorage; state: TestState; calls: string[] } {
         const calls: string[] = [];
         const services = makeNoopSharedServices<ServerSharedServices>({
            model: {
               ModelService: {
                  ...makeSessionModelService({ calls, documents, openError: options.openError }),
                  onModelUpdated: () => ({ dispose() {} })
               }
            },
            workspace: {
               AstDocumentManager: {
                  save: async (uri: string) => {
                     calls.push(`save ${uri}`);
                     await options.onSave?.(uri);
                  }
               },
               TextDocuments: { get: () => undefined, isOpenInClient: (uri: string) => open.has(uri) }
            }
         });
         const { storage, state } = createStorage('client-1', services, options.logger);
         calls.length = 0;
         return { storage, state, calls };
      }

      it('opens a document that joins the write set, and not one that does not exist yet', async () => {
         const { state, calls } = createOpeningStorage(['file:///a/side.x'], new Set());

         state.trackSecondaryDocument('file:///a/side.x');
         state.trackSecondaryDocument('file:///a/new.x');

         expect(calls).toEqual(['open file:///a/side.x']);
      });

      it('keeps a document that leaves the write set open until the next save has saved it', async () => {
         const open = new Set(['file:///a/side.x']);
         const { storage, state, calls } = createOpeningStorage(['file:///a/side.x'], open);
         state.trackSecondaryDocument('file:///a/side.x');
         calls.length = 0;

         state.untrackSecondaryDocuments();
         expect(calls).toEqual([]);

         await storage.callFlushWriteSet('file:///a/main.x');
         expect(calls).toEqual(['save file:///a/side.x', 'close file:///a/side.x']);
      });

      it('keeps a document that left the write set open when the save failed', async () => {
         const open = new Set(['file:///a/side.x']);
         const { storage, state, calls } = createOpeningStorage(['file:///a/side.x'], open, {
            onSave: () => Promise.reject(new Error('disk full'))
         });
         state.trackSecondaryDocument('file:///a/side.x');
         state.untrackSecondaryDocuments();
         calls.length = 0;

         await expect(storage.callFlushWriteSet('file:///a/main.x')).rejects.toThrow('disk full');
         expect(calls).toEqual(['save file:///a/side.x']);
      });

      it('keeps a document that leaves the write set during the save open for the next save', async () => {
         // Its text was taken before it left; edits made since are unsaved.
         const open = new Set(['file:///a/side.x']);
         const opened = createOpeningStorage(['file:///a/side.x'], open, {
            onSave: async () => opened.state.untrackSecondaryDocuments()
         });
         opened.state.trackSecondaryDocument('file:///a/side.x');
         opened.calls.length = 0;

         await opened.storage.callFlushWriteSet('file:///a/main.x');
         expect(opened.calls).toEqual(['save file:///a/side.x']);
      });

      it('logs an open the ending session refused at debug, not as a warning', async () => {
         const { logger, lines } = makeCapturingGlspLogger();
         const { state } = createOpeningStorage(['file:///a/side.x'], new Set(), {
            openError: new SessionClosedError('client-1'),
            logger
         });

         state.trackSecondaryDocument('file:///a/side.x');
         await waitFor(() => lines.some(line => line.message.includes('Could not open file:///a/side.x')));

         expect(lines.filter(line => line.message.includes('Could not open')).map(line => line.level)).toEqual(['debug']);
      });

      it('does not close a document that rejoined the write set before the save', async () => {
         const open = new Set(['file:///a/side.x']);
         const { storage, state, calls } = createOpeningStorage(['file:///a/side.x'], open);
         state.trackSecondaryDocument('file:///a/side.x');
         state.untrackSecondaryDocuments();
         state.trackSecondaryDocument('file:///a/side.x');
         calls.length = 0;

         await storage.callFlushWriteSet('file:///a/main.x');
         expect(calls).toEqual(['save file:///a/side.x']);
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
            MessageRenderer: shared => new GlspCatalogueRenderer(shared),
            model: { ModelService: makeSessionModelService() }
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

   describe('saveSourceModel — write set', () => {
      it('flushes the stored text of the primary, with no model handed to the write', async () => {
         const { storage, saveMock } = createPolicyStorage({ save: () => Promise.resolve() });
         await storage.saveSourceModel(saveAction);
         expect(saveMock.mock.calls).toEqual([['file:///x.a', 'client-1']]);
      });

      it('flushes every tracked secondary, not only the document the action names', async () => {
         const { storage, saveMock } = createPolicyStorage({ save: () => Promise.resolve(), secondaryUris: ['file:///x.layout'] });
         await storage.saveSourceModel(saveAction);
         expect(saveMock.mock.calls.map(call => call[0])).toEqual(['file:///x.a', 'file:///x.layout']);
      });

      it('skips a tracked document the diagram does not have open, even when another client does', async () => {
         // The other client's unsaved edits are not the diagram's to persist.
         const { storage, saveMock } = createPolicyStorage({
            save: () => Promise.resolve(),
            secondaryUris: ['file:///x.layout'],
            openUris: ['file:///x.a'],
            openElsewhere: ['file:///x.layout']
         });
         await storage.saveSourceModel(saveAction);
         expect(saveMock.mock.calls.map(call => call[0])).toEqual(['file:///x.a']);
      });

      it('saves nothing for a diagram that registered no session', async () => {
         // The client id's opens are then another participant's.
         const { storage, saveMock } = createPolicyStorage({ save: () => Promise.resolve(), refuseSession: true });
         await expect(storage.saveSourceModel(saveAction)).rejects.toThrow(DIAGRAM_SESSION_REFUSED.text);
         expect(saveMock).not.toHaveBeenCalled();
      });

      it('calls every save before any of them settles', async () => {
         // Each save takes its text when called. Called one after another, a
         // session ending during the first write would close the rest before
         // their text was taken.
         const { storage, saveMock } = createPolicyStorage({
            save: () => new Promise<void>(() => undefined),
            secondaryUris: ['file:///x.layout']
         });
         void storage.saveSourceModel(saveAction);
         expect(saveMock.mock.calls.map(call => call[0])).toEqual(['file:///x.a', 'file:///x.layout']);
      });

      it('saves a primary tracked as its own secondary once', async () => {
         const { storage, saveMock } = createPolicyStorage({ save: () => Promise.resolve(), secondaryUris: ['file:///x.a'] });
         await storage.saveSourceModel(saveAction);
         expect(saveMock.mock.calls.map(call => call[0])).toEqual(['file:///x.a']);
      });
   });

   describe('saveSourceModel — delivery policy', () => {
      it('defaults to awaiting the flush when no policy is bound', async () => {
         const { storage, saveMock } = createPolicyStorage({ save: () => Promise.resolve() });
         const result = storage.saveSourceModel(saveAction);
         expect(result).toBeInstanceOf(Promise);
         await result;
         expect(saveMock).toHaveBeenCalledTimes(1);
      });

      it('await propagates the failure', async () => {
         const failure = new Error('disk full');
         const { storage } = createPolicyStorage({ policy: { kind: 'await' }, save: () => Promise.reject(failure) });
         await expect(storage.saveSourceModel(saveAction)).rejects.toBe(failure);
      });

      it('fire-and-forget returns undefined, and swallows + logs failures', async () => {
         const { storage, lines } = createPolicyStorage({
            policy: { kind: 'fire-and-forget' },
            save: () => Promise.reject(new Error('disk full'))
         });
         const result = storage.saveSourceModel(saveAction);
         expect(result).toBeUndefined();
         // Wait for the line rather than for a fixed number of microtasks: how
         // many ticks separate the flush from the rejection depends on what the
         // save path awaits, which this assertion must not encode.
         const logged = async (): Promise<boolean> => {
            for (let attempt = 0; attempt < 50; attempt++) {
               if (lines.some(line => line.level === 'error' && line.message.includes('Save failed for file:///x.a'))) {
                  return true;
               }
               await new Promise(resolve => setTimeout(resolve, 1));
            }
            return false;
         };
         // Caught and logged, never rethrown.
         expect(await logged()).toBe(true);
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

      it('ends the client session once every subscription is drained', () => {
         // Last, so the closes it causes find the detach listener gone rather
         // than reporting this teardown as a client detaching.
         const calls: string[] = [];
         const { storage } = createStorage(
            'client-1',
            makeNoopSharedServices<ServerSharedServices>({ model: { ModelService: makeSessionModelService({ calls }) } })
         );
         storage.pushDisposable({ dispose: () => calls.push('subscription') });
         storage.dispose();
         expect(calls.slice(1)).toEqual(['subscription', 'dispose']);
      });

      it('drops the ended session from the state and registers none again', () => {
         const calls: string[] = [];
         const { storage, state } = createStorage(
            'client-1',
            makeNoopSharedServices<ServerSharedServices>({ model: { ModelService: makeSessionModelService({ calls }) } })
         );
         storage.dispose();

         expect(state.modelSession).toBeUndefined();
         expect(() => storage.callRequireModelSession()).toThrow(SessionClosedError);
         // The sentence can reach an end user, so the id travels in `data` only.
         expect(() => storage.callRequireModelSession()).not.toThrow('client-1');
         expect(calls.filter(call => call.startsWith('createSession'))).toHaveLength(1);
      });

      it('fails a save after dispose as a closed session, not as a held id', async () => {
         const { storage } = createStorage('client-1');
         storage.dispose();

         await expect(storage.callFlushWriteSet('file:///a/main.x')).rejects.toThrow(SessionClosedError);
      });

      it('ends a load still waiting for a held id as a closed session when disposed, and tells no one', async () => {
         const { storage } = createStorage(
            'client-1',
            makeNoopSharedServices<ServerSharedServices>({
               model: { ModelService: makeSessionModelService({ refuse: true }) },
               workspace: { TextDocuments: { onDidCloseSession: () => ({ dispose() {} }) } }
            })
         );
         const dispatch = vi.fn(() => Promise.resolve());
         (storage as unknown as { actionDispatcher: unknown }).actionDispatcher = { dispatch };

         const loading = storage.callAwaitModelSession();
         storage.dispose();

         await expect(loading).rejects.toThrow(SessionClosedError);
         expect(dispatch).not.toHaveBeenCalled();
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
