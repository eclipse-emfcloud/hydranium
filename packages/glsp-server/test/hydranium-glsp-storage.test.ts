/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it, vi } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import {
   type Action,
   ActionDispatcher,
   ClientId,
   type ClientSession,
   ClientSessionManager,
   CommandStack,
   GLSPServerError,
   GModelIndex,
   GModelSerializer,
   Logger as GlspLogger,
   type Marker,
   MarkersReason,
   ModelState,
   ModelSubmissionHandler,
   RequestModelAction,
   SOURCE_URI_ARG,
   SaveModelAction,
   SetDirtyStateAction,
   SetMarkersAction
} from '@eclipse-glsp/server';
import 'reflect-metadata';
import { Container } from 'inversify';
import { type AstNode } from '@hydranium/langium';
import {
   type AstDiagnostic,
   AstDocument,
   type AstDocumentUpdatedEvent,
   type ClientSession as ModelClientSession,
   type ClientSessionPersistArgs,
   DefaultModelLedger,
   type ServerSharedServices,
   type SessionEndCause,
   UNKNOWN_CLIENT_ID
} from '@hydranium/core';
import { makeFakeAstNode, makeNoopSharedServices, makeNoopTracer } from '@hydranium/core/testing';
import { DefaultMessageRenderer } from '@hydranium/core/messages';
import { type CapturedGlspLine, makeCapturingGlspLogger, makeNoopGlspLogger } from '../src/testing/index.js';
import { DiagramStatus } from '../src/state/diagram-status.js';
import { HydraniumGlspIndex } from '../src/state/hydranium-glsp-index.js';
import { AbstractHydraniumGlspState } from '../src/state/abstract-hydranium-glsp-state.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';
import {
   DuplicateClientIdError,
   RESUME_TOKEN_ARG,
   ReconcilingConflictResolver,
   SessionClosedError,
   asCanonicalUri
} from '@hydranium/protocol';
import { makeFakeClock, tick, waitFor } from '@hydranium/protocol/testing';
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

   public callIsStructurallyBroken(document: AstDocument<AstNode>): boolean {
      return this.isStructurallyBroken(document);
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

   public callRegisterModelSession(): void {
      this.state.modelSession = this.registerModelSession();
   }

   public callLoadModelSession(resumeToken?: unknown): Promise<ModelClientSession<AstNode>> {
      return this.loadModelSession(
         RequestModelAction.create({ options: resumeToken === undefined ? {} : { [RESUME_TOKEN_ARG]: resumeToken as string } })
      );
   }
}

/**
 * Records the resubmits and marker refreshes an update event causes instead of
 * performing them, and never finds itself stale, so the update handlers run to
 * their decision.
 */
class UpdateRecordingStorage extends TestStorage {
   resubmits = 0;
   markerRefreshes = 0;

   callHandleModelUpdated(event: AstDocumentUpdatedEvent<AstNode>): Promise<void> {
      return this.handleModelUpdated('file:///x.a', event);
   }

   callHandleSecondaryUpdated(event: AstDocumentUpdatedEvent<AstNode>): void {
      this.handleSecondaryUpdated('file:///x.layout', event);
   }

   protected override scheduleUpdateAndSubmit(): void {
      this.resubmits++;
   }

   protected override currentPrimaryDocument(): AstDocument<AstNode> {
      return AstDocument.create('file:///x.a', 1, { $type: 'TestRoot' });
   }

   protected override disposeIfStale(): boolean {
      return false;
   }

   override async refreshDiagnosticMarkers(): Promise<void> {
      this.markerRefreshes++;
   }
}

/**
 * The diagram's client session as the storage sees it: records what it is asked
 * to do into `calls`, fails every open with `openError`, and hands each persist
 * to `persist`. Once disposed every member but `dispose` throws
 * `SessionClosedError` synchronously, before returning a promise, as the
 * `ClientSession` contract has an ended session do; an async double would turn
 * that throw into a rejection the real session never produces.
 */
function makeRecordingModelSession(
   clientId: string,
   calls: string[],
   openError?: Error,
   persist?: (args: ClientSessionPersistArgs, clientId: string) => Promise<unknown>
): ModelClientSession<AstNode> {
   let disposed = false;
   const assertLive = (): void => {
      if (disposed) {
         throw new SessionClosedError(clientId);
      }
   };
   const session = {
      clientId,
      label: 'diagram',
      open(uri: string): Promise<void> {
         assertLive();
         calls.push(`open ${uri}`);
         return openError ? Promise.reject(openError) : Promise.resolve();
      },
      persist(args: ClientSessionPersistArgs): Promise<unknown> {
         assertLive();
         if (!persist) {
            throw new Error(`Unexpected persist of ${args.uri}`);
         }
         return persist(args, clientId);
      },
      close(uri: string): Promise<void> {
         assertLive();
         calls.push(`close ${uri}`);
         return Promise.resolve();
      },
      dispose(cause?: SessionEndCause): void {
         disposed = true;
         calls.push(cause === 'lost' ? 'dispose lost' : 'dispose');
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
   options: {
      calls?: string[];
      refuse?: boolean;
      holder?: Pick<ModelClientSession<AstNode>, 'onDidDispose'>;
      documents?: readonly string[];
      openError?: Error;
      persist?: (args: ClientSessionPersistArgs, clientId: string) => Promise<unknown>;
   } = {}
): object {
   const calls = options.calls ?? [];
   return {
      snapshot: () => undefined,
      getSession: () => options.holder,
      getDocument: (uri: string) => (options.documents?.includes(uri) ? { uri, parseResult: { value: { $type: 'Root' } } } : undefined),
      createSession(label: string, clientId: string, sessionOptions?: { resumeToken?: string }): ModelClientSession<AstNode> {
         calls.push(`createSession ${label} ${clientId}${sessionOptions?.resumeToken ? ` ${sessionOptions.resumeToken}` : ''}`);
         if (options.refuse) {
            throw new DuplicateClientIdError(clientId);
         }
         return makeRecordingModelSession(clientId, calls, options.openError, options.persist);
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
   logger: GlspLogger = makeNoopGlspLogger(),
   storageClass: typeof TestStorage = TestStorage
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
      startedSubmissions: 0,
      submitModel: () => Promise.resolve([]),
      withdrawLastSubmission: () => undefined
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
   container.bind(TestStorage).to(storageClass).inSingletonScope();
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
      workspace: { DocumentUriPolicy: { canonicalUri: (uri: string) => uri } },
      model: {
         ModelService: {
            ...makeSessionModelService(),
            // Read by the state's version capture on every registration; no
            // document exists here, and `undefined` is the same answer a real
            // service gives for an unopened URI.
            snapshot: () => undefined,
            getDocument: () => undefined,
            onModelUpdated(_listener: unknown, filter: { uri: string }) {
               log.subscribed.push(filter.uri);
               return {
                  dispose() {
                     log.disposed.push(filter.uri);
                  }
               };
            }
         }
      }
   });
   return { services, log };
}

/** Storage that keeps the base {@link HydraniumGlspStorage.saveSourceModel} so the policy branches are exercised. */
class PolicyStorage extends HydraniumGlspStorage<TestRoot> {
   /** Deliver a dirty flip of `uri`, as the text store does. */
   dirtyChanged(uri: string, dirty: boolean): void {
      this.handleDirtyChanged({ uri: asCanonicalUri(uri), text: { version: 1, hash: '', dirty } });
   }

   /** Register the session as a load does, so a save has one to write through. */
   register(): void {
      this.state.modelSession = this.registerModelSession();
   }
}

/**
 * Build a {@link PolicyStorage} over a mock of the diagram session's `persist`
 * and a stub state (`clientId`, `sourceRoot`, `secondaryUris`). Binds
 * {@link SaveDeliveryPolicyToken} only when a policy is given, so the unbound
 * default path is testable.
 *
 * `openUris` are the documents the diagram's session has open, which is what
 * the flush saves; `openElsewhere` are open only in another client.
 *
 * Whether a persist reaches disk is the session's own decision and is covered
 * where that lives; mocking it here leaves these cases about the write SET —
 * which URIs the flush names, in what order, and how many times.
 */
function createPolicyStorage(options: {
   policy?: SaveDeliveryPolicy;
   persist: (args: ClientSessionPersistArgs, clientId: string) => Promise<unknown>;
   secondaryUris?: readonly string[];
   openUris?: readonly string[];
   openElsewhere?: readonly string[];
   refuseSession?: boolean;
}): {
   storage: PolicyStorage;
   persistMock: ReturnType<typeof vi.fn>;
   root: TestRoot;
   lines: CapturedGlspLine[];
   /** The dirty states the storage dispatched, as `isDirty reason`. */
   dirtyStates: string[];
} {
   const root: TestRoot = { $type: 'TestRoot' };
   const persistMock = vi.fn(options.persist);
   const open = new Set(options.openUris ?? ['file:///x.a', ...(options.secondaryUris ?? [])]);
   const openElsewhere = new Set(options.openElsewhere ?? []);
   const { logger, lines } = makeCapturingGlspLogger();
   const container = new Container();
   container.bind(GlspLogger).toConstantValue(logger);
   container.bind(HydraniumTypes.SharedCoreServices).toConstantValue(
      makeNoopSharedServices<ServerSharedServices>({
         workspace: {
            ModelLedger: new DefaultModelLedger(),
            DocumentUriPolicy: { canonicalUri: (uri: string) => uri },
            AstDocumentManager: { isOpen: (uri: string) => open.has(uri) || openElsewhere.has(uri) },
            TextDocuments: {
               isOpenInClient: (uri: string, clientId: string) => (clientId === 'client-1' ? open : openElsewhere).has(uri)
            }
         },
         model: { ModelService: makeSessionModelService({ refuse: options.refuseSession, persist: persistMock }) }
      })
   );
   container.bind(HydraniumTypes.Tracer).toConstantValue(makeNoopTracer());
   container.bind(ClientSessionManager).toConstantValue({
      addListener() {},
      removeListener() {},
      getSession: () => undefined
   } as unknown as ClientSessionManager);
   const dirtyStates: string[] = [];
   container.bind(ActionDispatcher).toConstantValue({
      dispatch: (action: Action) => {
         if (SetDirtyStateAction.is(action)) {
            dirtyStates.push(`${action.isDirty} ${action.reason ?? 'none'}`);
         }
         return Promise.resolve();
      },
      dispatchAll: () => Promise.resolve(undefined)
   } as unknown as ActionDispatcher);
   container.bind(ModelSubmissionHandler).toConstantValue({
      hasPendingInitialRequest: () => false,
      startedSubmissions: 0,
      submitModel: () => Promise.resolve([]),
      withdrawLastSubmission: () => undefined
   } as unknown as ModelSubmissionHandler);
   container.bind(CommandStack).toConstantValue({ saveIsDone() {}, isDirty: true } as unknown as CommandStack);
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
   const storage = container.get(PolicyStorage);
   storage.register();
   return { storage, persistMock, root, lines, dirtyStates };
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

      it('registers the GLSP client id as a client session at load, with the request’s resume token', async () => {
         const calls: string[] = [];
         const { storage, state } = createStorage(
            'client-1',
            makeNoopSharedServices<ServerSharedServices>({ model: { ModelService: makeSessionModelService({ calls }) } })
         );
         expect(calls).toEqual([]);

         await storage.callLoadModelSession('token');

         expect(calls).toEqual(['createSession diagram client-1 token']);
         expect(state.modelSession?.clientId).toBe('client-1');
      });

      it('refuses a load whose token does not match at once, and tells the client', async () => {
         // A clock that never advances: a load that waited for the holder would never settle.
         const { storage, state } = createStorage(
            'client-1',
            makeNoopSharedServices<ServerSharedServices>({
               Clock: makeFakeClock(),
               model: { ModelService: makeSessionModelService({ refuse: true }) }
            })
         );
         const dispatch = vi.fn(() => Promise.resolve());
         (storage as unknown as { actionDispatcher: unknown }).actionDispatcher = { dispatch };

         await expect(storage.callLoadModelSession('token')).rejects.toThrow(
            expect.objectContaining({ message: DIAGRAM_SESSION_REFUSED.text, cause: expect.stringContaining('client-1') })
         );
         expect(state.modelSession).toBeUndefined();
         expect(dispatch).toHaveBeenCalledTimes(1);
      });
   });

   describe('a refused client id', () => {
      it('waits for a held id to free on a load without a token, and registers then', async () => {
         let holderEnded: ((cause: SessionEndCause) => void) | undefined;
         const options = {
            refuse: true,
            holder: {
               onDidDispose: (listener: (cause: SessionEndCause) => void) => {
                  holderEnded = listener;
                  return { dispose() {} };
               }
            }
         };
         const services = makeNoopSharedServices<ServerSharedServices>({ model: { ModelService: makeSessionModelService(options) } });
         const { storage, state } = createStorage('client-1', services);

         const loading = storage.callLoadModelSession();
         // Woken by the holder's end, not by the wait running out.
         await waitFor(() => holderEnded !== undefined);
         options.refuse = false;
         holderEnded?.('closed');

         expect((await loading).clientId).toBe('client-1');
         expect(state.modelSession?.clientId).toBe('client-1');
      });

      it('refuses a save before the diagram has loaded, and registers nothing for it', async () => {
         const calls: string[] = [];
         const { storage } = createStorage(
            'client-1',
            makeNoopSharedServices<ServerSharedServices>({ model: { ModelService: makeSessionModelService({ calls }) } })
         );

         await expect(storage.callFlushWriteSet('file:///a/main.x')).rejects.toThrow(DIAGRAM_SESSION_REFUSED.text);
         expect(calls).toEqual([]);
      });

      it('ignores a resume token that is not a string', async () => {
         const calls: string[] = [];
         const { storage } = createStorage(
            'client-1',
            makeNoopSharedServices<ServerSharedServices>({ model: { ModelService: makeSessionModelService({ calls }) } })
         );

         await storage.callLoadModelSession(42);

         expect(calls).toEqual(['createSession diagram client-1']);
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
                  ...makeSessionModelService({
                     calls,
                     documents,
                     openError: options.openError,
                     persist: async args => {
                        calls.push(`save ${args.uri}`);
                        await options.onSave?.(args.uri);
                     }
                  }),
                  onModelUpdated: () => ({ dispose() {} })
               }
            },
            workspace: {
               ModelLedger: new DefaultModelLedger(),
               DocumentUriPolicy: { canonicalUri: (uri: string) => uri },
               TextDocuments: { get: () => undefined, isOpenInClient: (uri: string) => open.has(uri) }
            }
         });
         const { storage, state } = createStorage('client-1', services, options.logger);
         storage.callRegisterModelSession();
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

      it('completes a save whose diagram ends during the writes, with a departed document left to close', async () => {
         // Ending the session closed everything it had open; there is nothing
         // left to close, and every write landed.
         const open = new Set(['file:///a/side.x']);
         const opened = createOpeningStorage(['file:///a/side.x'], open, {
            onSave: async () => opened.storage.dispose()
         });
         opened.state.trackSecondaryDocument('file:///a/side.x');
         opened.state.untrackSecondaryDocuments();
         opened.calls.length = 0;

         await opened.storage.callFlushWriteSet('file:///a/main.x');
         expect(opened.calls).toEqual(['save file:///a/side.x', 'dispose']);
      });

      it('completes a save whose session the store ends during the writes, with a departed document left to close', async () => {
         // The store ends the session without the storage: the state still
         // holds the ended handle, which refuses the close.
         const open = new Set(['file:///a/side.x']);
         const opened = createOpeningStorage(['file:///a/side.x'], open, {
            onSave: async () => opened.state.modelSession?.dispose()
         });
         opened.state.trackSecondaryDocument('file:///a/side.x');
         opened.state.untrackSecondaryDocuments();
         opened.calls.length = 0;

         await opened.storage.callFlushWriteSet('file:///a/main.x');
         expect(opened.calls).toEqual(['save file:///a/side.x', 'dispose']);
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

   describe('isStructurallyBroken', () => {
      const parsingError: AstDiagnostic = {
         severity: DiagnosticSeverity.Error,
         message: 'boom',
         range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
         data: { code: 'parsing-error' }
      };

      /** A root whose document's current parse is `parse`, or another root's when `replaced`. */
      function parsedRoot(parse: { parserErrors?: unknown[]; lexerErrors?: unknown[] }, replaced = false): AstNode {
         const root = makeFakeAstNode<AstNode>({ $type: 'TestRoot' });
         const value = replaced ? makeFakeAstNode<AstNode>({ $type: 'TestRoot' }) : root;
         Object.assign(root, {
            $document: { parseResult: { value, parserErrors: parse.parserErrors ?? [], lexerErrors: parse.lexerErrors ?? [] } }
         });
         return root;
      }

      it('reads a parser error off the root before validation has filled any diagnostic', () => {
         const { storage } = createStorage('client-structural');
         const document = AstDocument.create('file:///a.x', 1, parsedRoot({ parserErrors: [{ message: 'boom' }] }));

         expect(storage.callIsStructurallyBroken(document)).toBe(true);
      });

      it("answers the root's own clean parse over an earlier build's diagnostics", () => {
         const { storage } = createStorage('client-structural');
         const document = AstDocument.create('file:///a.x', 1, parsedRoot({}), [parsingError]);

         expect(storage.callIsStructurallyBroken(document)).toBe(false);
      });

      it('falls back to the diagnostics for a root its document has since replaced', () => {
         const { storage } = createStorage('client-structural');
         const document = AstDocument.create('file:///a.x', 1, parsedRoot({}, true), [parsingError]);

         expect(storage.callIsStructurallyBroken(document)).toBe(true);
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
         const dispatch = vi.fn((_action: SetMarkersAction) => Promise.resolve());
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
         const dispatch = vi.fn((_action: SetMarkersAction) => Promise.resolve());
         (storage as unknown as { modelValidator: unknown }).modelValidator = { validate: () => [] };
         (storage as unknown as { actionDispatcher: unknown }).actionDispatcher = { dispatch };

         await storage.refreshDiagnosticMarkers();

         expect((dispatch.mock.calls[0][0] as SetMarkersAction).markers).toEqual([]);
      });

      it('logs a validator that throws as an error, and markers it cannot send as a warning, never rejecting', async () => {
         const throwingLog = makeCapturingGlspLogger();
         const throwing = createStorage('client-1', undefined, throwingLog.logger).storage;
         (throwing as unknown as { modelValidator: unknown }).modelValidator = {
            validate: () => Promise.reject(new Error('validator bug'))
         };
         (throwing as unknown as { actionDispatcher: unknown }).actionDispatcher = { dispatch: vi.fn() };
         await expect(throwing.refreshDiagnosticMarkers()).resolves.toBeUndefined();
         expect(throwingLog.lines.map(line => line.level)).toEqual(['error']);

         const unsendableLog = makeCapturingGlspLogger();
         const unsendable = createStorage('client-1', undefined, unsendableLog.logger).storage;
         (unsendable as unknown as { modelValidator: unknown }).modelValidator = { validate: () => [] };
         (unsendable as unknown as { actionDispatcher: unknown }).actionDispatcher = {
            dispatch: () => Promise.reject(new Error('Connection is disposed.'))
         };
         await unsendable.refreshDiagnosticMarkers();
         await waitFor(() => unsendableLog.lines.length > 0);
         expect(unsendableLog.lines.map(line => line.level)).toEqual(['warn']);
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
      it("persists the primary's stored text through the diagram's session, whatever version the store holds", async () => {
         const { storage, persistMock } = createPolicyStorage({ persist: () => Promise.resolve() });
         await storage.saveSourceModel(saveAction);
         expect(persistMock.mock.calls).toEqual([[{ uri: 'file:///x.a', baseVersion: 'any' }, 'client-1']]);
      });

      it('flushes every tracked secondary, not only the document the action names', async () => {
         const { storage, persistMock } = createPolicyStorage({ persist: () => Promise.resolve(), secondaryUris: ['file:///x.layout'] });
         await storage.saveSourceModel(saveAction);
         expect(persistMock.mock.calls.map(call => call[0].uri)).toEqual(['file:///x.a', 'file:///x.layout']);
      });

      it('skips a tracked document the diagram does not have open, even when another client does', async () => {
         // The other client's unsaved edits are not the diagram's to persist.
         const { storage, persistMock } = createPolicyStorage({
            persist: () => Promise.resolve(),
            secondaryUris: ['file:///x.layout'],
            openUris: ['file:///x.a'],
            openElsewhere: ['file:///x.layout']
         });
         await storage.saveSourceModel(saveAction);
         expect(persistMock.mock.calls.map(call => call[0].uri)).toEqual(['file:///x.a']);
      });

      it('saves nothing for a diagram that registered no session', async () => {
         // The client id's opens are then another participant's.
         const { storage, persistMock } = createPolicyStorage({ persist: () => Promise.resolve(), refuseSession: true });
         await expect(storage.saveSourceModel(saveAction)).rejects.toThrow(DIAGRAM_SESSION_REFUSED.text);
         expect(persistMock).not.toHaveBeenCalled();
      });

      it('calls every save before any of them settles', async () => {
         // Each save takes its text when called. Called one after another, a
         // session ending during the first write would close the rest before
         // their text was taken.
         const { storage, persistMock } = createPolicyStorage({
            persist: () => new Promise<void>(() => undefined),
            secondaryUris: ['file:///x.layout']
         });
         void storage.saveSourceModel(saveAction);
         expect(persistMock.mock.calls.map(call => call[0].uri)).toEqual(['file:///x.a', 'file:///x.layout']);
      });

      it('persists every document when the persist of an earlier one throws instead of rejecting', async () => {
         const { storage, persistMock } = createPolicyStorage({
            persist: args => {
               if (args.uri === 'file:///x.a') {
                  throw new Error('refused');
               }
               return Promise.resolve();
            },
            secondaryUris: ['file:///x.layout']
         });
         await expect(storage.saveSourceModel(saveAction)).rejects.toThrow('refused');
         expect(persistMock.mock.calls.map(call => call[0].uri)).toEqual(['file:///x.a', 'file:///x.layout']);
      });

      it('fails with the first document that failed, and logs every failure under its own document', async () => {
         const { storage, lines } = createPolicyStorage({
            persist: args => Promise.reject(new Error(`refused ${args.uri}`)),
            secondaryUris: ['file:///x.layout']
         });
         await expect(storage.saveSourceModel(saveAction)).rejects.toThrow('refused file:///x.a');
         expect(lines.filter(line => line.level === 'error').map(line => line.message)).toEqual([
            'Save failed for file:///x.a: refused file:///x.a',
            'Save failed for file:///x.layout: refused file:///x.layout'
         ]);
      });

      it('settles a failed save only once every other document of the set has been written', async () => {
         let finishLayout!: () => void;
         const { storage } = createPolicyStorage({
            persist: args =>
               args.uri === 'file:///x.a' ? Promise.reject(new Error('refused')) : new Promise<void>(resolve => (finishLayout = resolve)),
            secondaryUris: ['file:///x.layout']
         });
         let settled = false;
         const saving = Promise.resolve(storage.saveSourceModel(saveAction)).finally(() => (settled = true));
         saving.catch(() => undefined);

         await tick();
         expect(settled).toBe(false);
         finishLayout();

         await expect(saving).rejects.toThrow('refused');
      });

      it('saves a primary tracked as its own secondary once', async () => {
         const { storage, persistMock } = createPolicyStorage({ persist: () => Promise.resolve(), secondaryUris: ['file:///x.a'] });
         await storage.saveSourceModel(saveAction);
         expect(persistMock.mock.calls.map(call => call[0].uri)).toEqual(['file:///x.a']);
      });
   });

   describe('saveSourceModel — delivery policy', () => {
      it('defaults to awaiting the flush when no policy is bound', async () => {
         const { storage, persistMock } = createPolicyStorage({ persist: () => Promise.resolve() });
         const result = storage.saveSourceModel(saveAction);
         expect(result).toBeInstanceOf(Promise);
         await result;
         expect(persistMock).toHaveBeenCalledTimes(1);
      });

      it('await propagates the failure', async () => {
         const failure = new Error('disk full');
         const { storage } = createPolicyStorage({ policy: { kind: 'await' }, persist: () => Promise.reject(failure) });
         await expect(storage.saveSourceModel(saveAction)).rejects.toBe(failure);
      });

      it('fire-and-forget returns undefined, and swallows + logs failures', async () => {
         const { storage, lines } = createPolicyStorage({
            policy: { kind: 'fire-and-forget' },
            persist: () => Promise.reject(new Error('disk full'))
         });
         const result = storage.saveSourceModel(saveAction);
         expect(result).toBeUndefined();
         // Wait for the line rather than for a fixed number of microtasks: how
         // many ticks separate the flush from the rejection depends on what the
         // save path awaits, which this assertion must not encode.
         const logged = async (): Promise<boolean> => {
            for (let attempt = 0; attempt < 50; attempt++) {
               if (lines.some(line => line.level === 'error' && line.message.includes('Diagram save failed for file:///x.a'))) {
                  return true;
               }
               await new Promise(resolve => setTimeout(resolve, 1));
            }
            return false;
         };
         // Caught and logged, never rethrown.
         expect(await logged()).toBe(true);
      });

      it('fire-and-forget names the document that failed, then the diagram, when only a secondary failed', async () => {
         const { storage, lines } = createPolicyStorage({
            policy: { kind: 'fire-and-forget' },
            persist: args => (args.uri === 'file:///x.layout' ? Promise.reject(new Error('disk full')) : Promise.resolve()),
            secondaryUris: ['file:///x.layout']
         });
         storage.saveSourceModel(saveAction);

         await waitFor(() => lines.some(line => line.message.startsWith('Diagram save failed')));
         expect(lines.filter(line => line.level === 'error').map(line => line.message)).toEqual([
            'Save failed for file:///x.layout: disk full',
            'Diagram save failed for file:///x.a: disk full'
         ]);
      });
   });

   describe('saveSourceModel — dirty state', () => {
      // GLSP's save handler sends the dirty state, reason save, once the save
      // settles, and GLSP's client keeps a dirty state only when it changes:
      // the save's own flip sent first, reason external, leaves the save's
      // answer changing nothing, and a saveable waiting for it times out.
      it('sends no dirty state for a flip during its own awaited save', async () => {
         let finish!: () => void;
         const { storage, dirtyStates } = createPolicyStorage({ persist: () => new Promise<void>(resolve => (finish = resolve)) });

         const saving = storage.saveSourceModel(saveAction);
         storage.dirtyChanged('file:///x.a', false);
         finish();
         await saving;

         expect(dirtyStates).toEqual([]);
      });

      it('sends the dirty state once a failed save settles, since GLSP then sends none', async () => {
         let fail!: (error: Error) => void;
         const { storage, dirtyStates } = createPolicyStorage({
            persist: () => new Promise<void>((_resolve, reject) => (fail = reject))
         });

         const saving = storage.saveSourceModel(saveAction);
         storage.dirtyChanged('file:///x.a', true);
         expect(dirtyStates).toEqual([]);
         fail(new Error('disk full'));

         await expect(saving).rejects.toThrow('disk full');
         expect(dirtyStates).toEqual(['true external']);
      });

      it('ends its hold when a flush override throws before it returns a promise', async () => {
         const { storage, dirtyStates } = createPolicyStorage({ persist: () => Promise.resolve() });
         Object.assign(storage, {
            flushWriteSet: () => {
               throw new Error('flush refused');
            }
         });

         await expect(Promise.resolve().then(() => storage.saveSourceModel(saveAction))).rejects.toThrow('flush refused');
         storage.dirtyChanged('file:///x.a', true);

         expect(dirtyStates).toEqual(['true external', 'true external']);
      });

      it('sends a flip outside its own save, and one during a save it does not wait for', async () => {
         const { storage, dirtyStates } = createPolicyStorage({
            policy: { kind: 'fire-and-forget' },
            persist: () => new Promise<void>(() => undefined)
         });
         storage.dirtyChanged('file:///x.a', true);

         storage.saveSourceModel(saveAction);
         storage.dirtyChanged('file:///x.a', false);

         expect(dirtyStates).toEqual(['true external', 'true external']);
      });
   });

   describe('a resubmit that matches the last submission', () => {
      it('is taken back, so the revision the client holds still applies', async () => {
         const services = makeNoopSharedServices<ServerSharedServices>({
            model: { ModelService: { ...makeSessionModelService(), getDocument: () => undefined } },
            workspace: { ModelLedger: new DefaultModelLedger() }
         });
         const { storage } = createStorage('client-1', services);
         const withdrawLastSubmission = vi.fn();
         const handler = {
            hasPendingInitialRequest: () => false,
            startedSubmissions: 4,
            lastSubmittedSignature: 'unchanged',
            submitModel: () => {
               handler.startedSubmissions++;
               return Promise.resolve([{ kind: 'requestBounds' }]);
            },
            withdrawLastSubmission
         };
         (storage as unknown as { submissionHandler: unknown }).submissionHandler = handler;

         const actions = await (storage as unknown as { captureAndSubmit(uri: string, root: AstNode): Promise<unknown> }).captureAndSubmit(
            'file:///a/main.x',
            { $type: 'TestRoot' }
         );

         expect(actions).toEqual([]);
         expect(withdrawLastSubmission).toHaveBeenCalledExactlyOnceWith(5);
      });

      it('is sent when the graph changed', async () => {
         const services = makeNoopSharedServices<ServerSharedServices>({
            model: { ModelService: { ...makeSessionModelService(), getDocument: () => undefined } },
            workspace: { ModelLedger: new DefaultModelLedger() }
         });
         const { storage } = createStorage('client-1', services);
         const withdrawLastSubmission = vi.fn();
         const submitted: Action = { kind: 'requestBounds' };
         const handler = {
            hasPendingInitialRequest: () => false,
            startedSubmissions: 0,
            lastSubmittedSignature: 'before',
            submitModel: () => {
               handler.lastSubmittedSignature = 'after';
               return Promise.resolve([submitted]);
            },
            withdrawLastSubmission
         };
         (storage as unknown as { submissionHandler: unknown }).submissionHandler = handler;

         const actions = await (storage as unknown as { captureAndSubmit(uri: string, root: AstNode): Promise<unknown> }).captureAndSubmit(
            'file:///a/main.x',
            { $type: 'TestRoot' }
         );

         expect(actions).toEqual([submitted]);
         expect(withdrawLastSubmission).not.toHaveBeenCalled();
      });
   });

   describe('a resubmit whose primary is gone', () => {
      it('withdraws a parse-error status set before the primary was deleted', async () => {
         const services = makeNoopSharedServices<ServerSharedServices>({
            model: { ModelService: { ...makeSessionModelService(), getDocument: () => undefined } },
            workspace: { ModelLedger: new DefaultModelLedger() }
         });
         const { storage, state } = createStorage('client-1', services);
         state.setStatus(DiagramStatus.PARSE_ERROR, { severity: 'ERROR', message: 'broken', readonly: true });

         await (storage as unknown as { captureAndSubmit(uri: string, root: AstNode): Promise<unknown> }).captureAndSubmit(
            'file:///a/main.x',
            {
               $type: 'TestRoot'
            }
         );

         expect(state.currentStatus).toBeUndefined();
      });
   });

   describe('answering an update', () => {
      function updateRecordingStorage(): UpdateRecordingStorage {
         const { storage } = createStorage('client-1', undefined, undefined, UpdateRecordingStorage);
         if (!(storage instanceof UpdateRecordingStorage)) {
            throw new Error('the container built the wrong storage');
         }
         return storage;
      }

      /** An update of `uri` with the given attribution. */
      function updated(uri: string, attribution: Pick<AstDocumentUpdatedEvent<AstNode>, 'reason' | 'sourceClientId' | 'causedBy'>) {
         return { document: AstDocument.create(uri, 1, { $type: 'TestRoot' }), ...attribution };
      }

      // A write to a secondary sweeps the primary into its build, and the
      // primary arrives rebuilt. Its causedBy is what tells the diagram that
      // its own write caused it; the resubmit would land on the move the user
      // still holds.
      it('does not resubmit for a primary rebuilt by a build its own write caused, and still refreshes markers', async () => {
         const storage = updateRecordingStorage();

         await storage.callHandleModelUpdated(
            updated('file:///x.a', { reason: 'rebuilt', sourceClientId: UNKNOWN_CLIENT_ID, causedBy: 'client-1' })
         );

         expect(storage.resubmits).toBe(0);
         expect(storage.markerRefreshes).toBe(1);
      });

      it('resubmits for a primary rebuilt by another client’s write, or by no single client', async () => {
         const storage = updateRecordingStorage();

         await storage.callHandleModelUpdated(
            updated('file:///x.a', { reason: 'rebuilt', sourceClientId: UNKNOWN_CLIENT_ID, causedBy: 'client-2' })
         );
         await storage.callHandleModelUpdated(
            updated('file:///x.a', { reason: 'rebuilt', sourceClientId: UNKNOWN_CLIENT_ID, causedBy: UNKNOWN_CLIENT_ID })
         );
         await storage.callHandleModelUpdated(updated('file:///x.a', { reason: 'rebuilt', sourceClientId: UNKNOWN_CLIENT_ID }));

         expect(storage.resubmits).toBe(3);
         expect(storage.markerRefreshes).toBe(3);
      });

      it('does not resubmit for its own change, and does for another client’s', async () => {
         const storage = updateRecordingStorage();

         await storage.callHandleModelUpdated(
            updated('file:///x.a', { reason: 'changed', sourceClientId: 'client-1', causedBy: 'client-1' })
         );
         await storage.callHandleModelUpdated(
            updated('file:///x.a', { reason: 'changed', sourceClientId: 'client-2', causedBy: 'client-2' })
         );

         expect(storage.resubmits).toBe(1);
      });

      it('answers a secondary’s update by the same rule', () => {
         const storage = updateRecordingStorage();

         storage.callHandleSecondaryUpdated(
            updated('file:///x.layout', { reason: 'rebuilt', sourceClientId: UNKNOWN_CLIENT_ID, causedBy: 'client-1' })
         );
         storage.callHandleSecondaryUpdated(
            updated('file:///x.layout', { reason: 'changed', sourceClientId: 'client-1', causedBy: 'client-1' })
         );
         storage.callHandleSecondaryUpdated(
            updated('file:///x.layout', { reason: 'rebuilt', sourceClientId: UNKNOWN_CLIENT_ID, causedBy: 'client-2' })
         );

         expect(storage.resubmits).toBe(1);
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
         storage.callRegisterModelSession();
         storage.pushDisposable({ dispose: () => calls.push('subscription') });
         storage.dispose();
         expect(calls.slice(1)).toEqual(['subscription', 'dispose']);
      });

      it('ends the client session with the cause it is disposed with, closed when none is given', () => {
         const ended = (dispose: (storage: TestStorage) => void): string[] => {
            const calls: string[] = [];
            const services = makeNoopSharedServices<ServerSharedServices>({ model: { ModelService: makeSessionModelService({ calls }) } });
            const { storage } = createStorage('client-1', services);
            storage.callRegisterModelSession();
            dispose(storage);
            return calls.filter(call => call.startsWith('dispose'));
         };

         expect(ended(storage => storage.dispose('lost'))).toEqual(['dispose lost']);
         expect(ended(storage => storage.sessionDisposed({ id: 'client-1' } as ClientSession))).toEqual(['dispose']);
      });

      it('drops the ended session from the state and registers none again', () => {
         const calls: string[] = [];
         const { storage, state } = createStorage(
            'client-1',
            makeNoopSharedServices<ServerSharedServices>({ model: { ModelService: makeSessionModelService({ calls }) } })
         );
         storage.callRegisterModelSession();
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

      it('refuses a load after dispose as a closed session, and tells no one', async () => {
         const { storage } = createStorage(
            'client-1',
            makeNoopSharedServices<ServerSharedServices>({ model: { ModelService: makeSessionModelService({ refuse: true }) } })
         );
         const dispatch = vi.fn(() => Promise.resolve());
         (storage as unknown as { actionDispatcher: unknown }).actionDispatcher = { dispatch };
         storage.dispose();

         await expect(storage.callLoadModelSession()).rejects.toThrow(SessionClosedError);
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
