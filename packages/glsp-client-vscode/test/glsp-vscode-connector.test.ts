/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// `vscode` exists only inside the extension host. As in the editor provider's
// test, the stub goes in at Node's loader too, with what the connector's
// constructor reaches for and a diagnostic collection that records its problems.
const { problems, restoreLoad, vscodeStub } = vi.hoisted(() => {
   const nodeModule = globalThis.process.getBuiltinModule('node:module') as typeof Module & {
      _load(request: string, ...rest: unknown[]): unknown;
   };
   const { Emitter } = nodeModule.createRequire(__filename)('vscode-jsonrpc') as typeof Jsonrpc;
   const problems = new Map<unknown, readonly { readonly message: string }[] | undefined>();
   const vscodeStub = {
      EventEmitter: Emitter,
      Range: class {},
      Diagnostic: class {
         constructor(
            readonly range: unknown,
            readonly message: string,
            readonly severity: unknown
         ) {}
      },
      DiagnosticSeverity: { Information: 2, Warning: 1, Error: 0 },
      languages: {
         createDiagnosticCollection: () => ({
            set: (uri: unknown, diagnostics: readonly { readonly message: string }[] | undefined) => problems.set(uri, diagnostics),
            dispose: () => undefined
         })
      },
      window: { showErrorMessage: vi.fn() }
   };
   const load = nodeModule._load;
   nodeModule._load = function (request: string, ...rest: unknown[]): unknown {
      return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
   };
   return {
      problems,
      vscodeStub,
      restoreLoad: (): void => {
         nodeModule._load = load;
      }
   };
});
vi.mock('vscode', () => vscodeStub);

import {
   type GlspVscodeClient,
   type GlspVscodeServer,
   type Marker,
   MarkersReason,
   MessageAction,
   RejectAction,
   SaveModelAction,
   SetDirtyStateAction,
   SetMarkersAction
} from '@eclipse-glsp/vscode-integration';
import { isSaveFailedError, ModelSavedAction, RequestSaveModelAction, SAVE_FAILED_ERROR_CODE, SaveFailedError } from '@hydranium/protocol';
import type { Module } from 'node:module';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from 'vscode-jsonrpc';
import type * as Jsonrpc from 'vscode-jsonrpc';
import type * as vscode from 'vscode';
import { HydraniumGlspVscodeConnector } from '../src/node/glsp-vscode-connector';

interface SentMessage {
   clientId: string;
   action: { kind: string; requestId?: string; fileUri?: string };
}

/** A connector whose held state a test can count. */
class InspectableConnector extends HydraniumGlspVscodeConnector {
   protected override abandonedSaveLimit = 2;

   heldState(): { abandoned: number; shown: number; rejected: number; markers: number } {
      return {
         abandoned: this.abandonedSaves.size,
         shown: this.shownSaveFailures.size,
         rejected: this.rejectedSaveMessages.size,
         markers: this.markersByReason.size
      };
   }
}

/** A connector with one registered client, recording what reaches the server and the webview. */
function setUp(serverActions: string[]): {
   connector: InspectableConnector;
   document: vscode.CustomDocument;
   toServer: SentMessage[];
   toWebview: unknown[];
   fromServer: (message: unknown) => void;
   closePanel: () => void;
} {
   const onSendToServerEmitter = new Emitter<unknown>();
   const onServerMessage = new Emitter<unknown>();
   const toServer: SentMessage[] = [];
   onSendToServerEmitter.event(message => toServer.push(message as SentMessage));
   // A GLSP client that never starts: registration stops short of the webview, which the save path does not need.
   const glspClient = new Promise(() => undefined);
   const server = { onSendToServerEmitter, onServerMessage: onServerMessage.event, glspClient } as unknown as GlspVscodeServer;
   const connector = new InspectableConnector({ server, messenger: {} as never });
   const onDidDispose = new Emitter<void>();
   const document = { uri: { path: '/a.x' } } as unknown as vscode.CustomDocument;
   const toWebview: unknown[] = [];
   const client = {
      clientId: 'client-1',
      document,
      webviewEndpoint: {
         serverActions,
         clientActions: [],
         webviewPanel: { onDidDispose: onDidDispose.event, onDidChangeViewState: () => ({ dispose: () => undefined }) },
         onActionMessage: () => ({ dispose: () => undefined }),
         sendMessage: (message: unknown) => toWebview.push(message)
      }
   } as unknown as GlspVscodeClient;
   void connector.registerClient(client);
   return {
      connector,
      document,
      toServer,
      toWebview,
      fromServer: message => onServerMessage.fire(message),
      closePanel: () => onDidDispose.fire()
   };
}

afterAll(() => restoreLoad());
afterEach(() => {
   vi.useRealTimers();
   vscodeStub.window.showErrorMessage.mockClear();
   problems.clear();
});

describe('HydraniumGlspVscodeConnector', () => {
   const advertised = [RequestSaveModelAction.KIND, SaveModelAction.KIND];

   it('resolves a save on the server answer, which the webview does not get', async () => {
      const { connector, document, toServer, toWebview, fromServer } = setUp(advertised);
      const saving = connector.saveDocument(document);
      const [sent] = toServer;
      expect(sent.action.kind).toBe(RequestSaveModelAction.KIND);
      fromServer({ clientId: 'client-1', action: ModelSavedAction.create({ responseId: sent.action.requestId }) });
      await expect(saving).resolves.toBeUndefined();
      expect(toWebview).toEqual([]);
   });

   it('rejects with the documents a save could not write, and why', async () => {
      const { connector, document, toServer, fromServer } = setUp(advertised);
      const saving = connector.saveDocument(document);
      const failures = [{ uri: 'file:///a.x', reason: 'EACCES' }];
      fromServer({ clientId: 'client-1', action: reject(toServer[0], failures) });
      const error: unknown = await saving.catch((reason: unknown) => reason);
      expect(isSaveFailedError(error) && error.failures).toEqual(failures);
   });

   it("shows a rejected save's failure in place of the server's notification, once until a save succeeds", async () => {
      // VS Code shows a rejected save only when the user started it, so an auto-save that fails would show nothing.
      const { connector, document, toServer, fromServer } = setUp(advertised);
      const failures = [{ uri: 'file:///a.x', reason: 'EACCES' }];
      // Each attempt's reason names its own staging file.
      const attempts = [denied('1-1111-1111-1111-111111111111'), denied('2-2222-2222-2222-222222222222')];
      for (const [i, attempt] of attempts.entries()) {
         const saving = connector.saveDocument(document).catch(() => undefined);
         fromServer({ clientId: 'client-1', action: reject(toServer[i], attempt) });
         fromServer({ clientId: 'client-1', action: notice(attempt) });
         await saving;
      }
      expect(shown()).toEqual([new SaveFailedError(attempts[0]).message]);

      const saved = connector.saveDocument(document);
      fromServer({ clientId: 'client-1', action: ModelSavedAction.create({ responseId: toServer[2].action.requestId }) });
      await saved;
      const failing = connector.saveDocument(document).catch(() => undefined);
      fromServer({ clientId: 'client-1', action: reject(toServer[3], failures) });
      await failing;
      expect(shown()).toEqual([new SaveFailedError(attempts[0]).message, new SaveFailedError(failures).message]);
   });

   it('shows a failure again when a document fails for another reason', async () => {
      const { connector, document, toServer, fromServer } = setUp(advertised);
      const attempts = [
         denied('1-1111-1111-1111-111111111111'),
         [{ uri: 'file:///a.x', reason: 'ENOSPC: no space left on device, write' }]
      ];
      for (const [i, attempt] of attempts.entries()) {
         const saving = connector.saveDocument(document).catch(() => undefined);
         fromServer({ clientId: 'client-1', action: reject(toServer[i], attempt) });
         await saving;
      }
      expect(shown()).toEqual(attempts.map(attempt => new SaveFailedError(attempt).message));
   });

   it("drops the server's notification for a rejected save whatever comes between, and no other", async () => {
      const { connector, document, toServer, fromServer } = setUp(advertised);
      const failures = [{ uri: 'file:///a.x', reason: 'EACCES' }];
      const saving = connector.saveDocument(document).catch(() => undefined);
      fromServer({ clientId: 'client-1', action: reject(toServer[0], failures) });
      fromServer({ clientId: 'client-1', action: MessageAction.create('Unrelated failure', { severity: 'ERROR' }) });
      fromServer({ clientId: 'client-1', action: notice(failures) });
      await saving;
      expect(shown()).toEqual([new SaveFailedError(failures).message, 'Unrelated failure']);
   });

   it("shows the server's error notifications that do not follow a rejected save", () => {
      const { fromServer } = setUp(advertised);
      fromServer({ clientId: 'client-1', action: RejectAction.create('Not a save', { responseId: 'other-request' }) });
      fromServer({ clientId: 'client-1', action: MessageAction.create('Unrelated failure', { severity: 'ERROR' }) });
      expect(vscodeStub.window.showErrorMessage.mock.calls).toEqual([['Unrelated failure']]);
   });

   it("rejects with the server's message when the detail is not a typed error, and leaves the notification to the server", async () => {
      const { connector, document, toServer, fromServer } = setUp(advertised);
      const saving = connector.saveDocument(document);
      fromServer({
         clientId: 'client-1',
         action: RejectAction.create('Failed to handle request', { responseId: toServer[0].action.requestId, detail: 'Error: boom' })
      });
      fromServer({ clientId: 'client-1', action: MessageAction.create("Could not process action: 'save", { severity: 'ERROR' }) });
      await expect(saving).rejects.toThrow('Failed to handle request');
      expect(vscodeStub.window.showErrorMessage.mock.calls).toEqual([["Could not process action: 'save"]]);
   });

   it('saves to the destination it is given', async () => {
      const { connector, document, toServer, fromServer } = setUp(advertised);
      const saving = connector.saveDocument(document, { path: '/b.x' } as vscode.Uri);
      expect(toServer[0].action.fileUri).toBe('/b.x');
      fromServer({ clientId: 'client-1', action: ModelSavedAction.create({ responseId: toServer[0].action.requestId }) });
      await saving;
   });

   it('rejects when the server does not answer in time, and keeps a late answer from the webview', async () => {
      vi.useFakeTimers();
      const { connector, document, toServer, toWebview, fromServer } = setUp(advertised);
      const saving = connector.saveDocument(document);
      const settled = expect(saving).rejects.toThrow('Save operation timed out');
      await vi.advanceTimersByTimeAsync(20_000);
      await settled;
      expect(vscodeStub.window.showErrorMessage.mock.calls).toEqual([['Save operation timed out']]);
      fromServer({ clientId: 'client-1', action: ModelSavedAction.create({ responseId: toServer[0].action.requestId }) });
      expect(toWebview).toEqual([]);
   });

   it("shows a typed rejection that comes after the timeout in place of the server's notification", async () => {
      vi.useFakeTimers();
      const { connector, document, toServer, toWebview, fromServer } = setUp(advertised);
      const failures = [{ uri: 'file:///a.x', reason: 'EACCES' }];
      const saving = connector.saveDocument(document).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(20_000);
      await saving;
      fromServer({ clientId: 'client-1', action: reject(toServer[0], failures) });
      fromServer({ clientId: 'client-1', action: notice(failures) });
      expect(shown()).toEqual(['Save operation timed out', new SaveFailedError(failures).message]);
      expect(toWebview).toEqual([]);
   });

   it('shows a save failure whose data it cannot read by its message', async () => {
      const { connector, document, toServer, fromServer } = setUp(advertised);
      const saving = connector.saveDocument(document);
      const detail = JSON.stringify({ code: SAVE_FAILED_ERROR_CODE, message: 'Could not save', data: {} });
      fromServer({ clientId: 'client-1', action: RejectAction.create('Failed', { responseId: toServer[0].action.requestId, detail }) });
      await expect(saving).rejects.toThrow('Could not save');
      expect(shown()).toEqual(['Could not save']);
   });

   it('shows nothing for an earlier save that fails after a later one has saved', async () => {
      vi.useFakeTimers();
      const { connector, document, toServer, toWebview, fromServer } = setUp(advertised);
      const failures = [{ uri: 'file:///a.x', reason: 'EACCES' }];
      const timedOut = connector.saveDocument(document).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(20_000);
      await timedOut;
      const saved = connector.saveDocument(document);
      fromServer({ clientId: 'client-1', action: ModelSavedAction.create({ responseId: toServer[1].action.requestId }) });
      await saved;

      fromServer({ clientId: 'client-1', action: reject(toServer[0], failures) });
      fromServer({ clientId: 'client-1', action: notice(failures) });
      expect(shown()).toEqual(['Save operation timed out']);
      expect(toWebview).toEqual([]);
   });

   it('shows no timeout for an earlier save once a later one has saved', async () => {
      vi.useFakeTimers();
      const { connector, document, toServer, fromServer } = setUp(advertised);
      const timedOut = connector.saveDocument(document).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10_000);
      const saved = connector.saveDocument(document);
      fromServer({ clientId: 'client-1', action: ModelSavedAction.create({ responseId: toServer[1].action.requestId }) });
      await saved;
      await vi.advanceTimersByTimeAsync(10_000);
      await timedOut;
      expect(shown()).toEqual([]);
   });

   it('shows a failure again after a save fails otherwise in between', async () => {
      const { connector, document, toServer, fromServer } = setUp(advertised);
      const failures = [{ uri: 'file:///a.x', reason: 'EACCES' }];
      const untyped = (request: SentMessage): RejectAction =>
         RejectAction.create('Failed to handle request', { responseId: request.action.requestId, detail: 'Error: boom' });
      for (const answer of [
         (request: SentMessage) => reject(request, failures),
         untyped,
         (request: SentMessage) => reject(request, failures)
      ]) {
         const saving = connector.saveDocument(document).catch(() => undefined);
         fromServer({ clientId: 'client-1', action: answer(toServer[toServer.length - 1]) });
         await saving;
      }
      const message = new SaveFailedError(failures).message;
      expect(shown()).toEqual([message, message]);
   });

   it('keeps only the latest timed-out saves, since a server may never answer', async () => {
      vi.useFakeTimers();
      const { connector, document } = setUp(advertised);
      const saves = [1, 2, 3].map(() => connector.saveDocument(document).catch(() => undefined));
      await vi.advanceTimersByTimeAsync(20_000);
      await Promise.all(saves);
      expect(connector.heldState().abandoned).toBe(2);
   });

   it('rejects pending saves and forgets the diagram when its panel closes', async () => {
      vi.useFakeTimers();
      const { connector, document, toServer, fromServer, closePanel } = setUp(advertised);
      const timedOut = connector.saveDocument(document).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(20_000);
      await timedOut;
      const failed = connector.saveDocument(document).catch(() => undefined);
      fromServer({ clientId: 'client-1', action: reject(toServer[1], [{ uri: 'file:///a.x', reason: 'EACCES' }]) });
      await failed;
      const pending = connector.saveDocument(document);
      fromServer({ clientId: 'client-1', action: markers(MarkersReason.LIVE, 'live issue') });

      closePanel();
      await expect(pending).rejects.toThrow('the diagram was closed');
      expect(connector.heldState()).toEqual({ abandoned: 0, shown: 0, rejected: 0, markers: 0 });
   });

   it('rejects the saves still pending when it is disposed', async () => {
      const { connector, document } = setUp(advertised);
      const saving = connector.saveDocument(document);
      connector.dispose();
      await expect(saving).rejects.toThrow('the connector was disposed');
   });

   it("shows every reason's markers in the Problems view, so an empty batch set leaves the live ones", () => {
      const { document, fromServer } = setUp(advertised);

      fromServer({ clientId: 'client-1', action: markers(MarkersReason.LIVE, 'live issue') });
      fromServer({ clientId: 'client-1', action: markers(MarkersReason.BATCH) });
      const afterEmptyBatch = problemMessages(document);
      fromServer({ clientId: 'client-1', action: markers(MarkersReason.BATCH, 'batch issue') });

      expect({ afterEmptyBatch, afterBatchIssue: problemMessages(document) }).toEqual({
         afterEmptyBatch: ['live issue'],
         afterBatchIssue: ['live issue', 'batch issue']
      });
   });

   it('replaces only the set of the reason sent, so a fixed live issue leaves the Problems view', () => {
      const { document, fromServer } = setUp(advertised);

      fromServer({ clientId: 'client-1', action: markers(MarkersReason.LIVE, 'live issue') });
      fromServer({ clientId: 'client-1', action: markers(MarkersReason.LIVE) });

      expect(problemMessages(document)).toEqual([]);
   });

   it('passes each markers action to the diagram unchanged, since its client keeps one set per reason itself', () => {
      const { fromServer, toWebview } = setUp(advertised);
      const live = { clientId: 'client-1', action: markers(MarkersReason.LIVE, 'live issue') };
      const batch = { clientId: 'client-1', action: markers(MarkersReason.BATCH) };

      fromServer(live);
      fromServer(batch);

      expect(toWebview).toEqual([live, batch]);
   });

   it("saves as GLSP's against a server that does not advertise the request", async () => {
      const { connector, document, toServer, fromServer } = setUp([SaveModelAction.KIND]);
      const saving = connector.saveDocument(document);
      expect(toServer[0].action.kind).toBe(SaveModelAction.KIND);
      fromServer({ clientId: 'client-1', action: SetDirtyStateAction.create(false, { reason: 'save' }) });
      await expect(saving).resolves.toBeUndefined();
   });
});

/** A `SetMarkersAction` under `reason` with one marker per description. */
function markers(reason: string, ...descriptions: string[]): SetMarkersAction {
   const set: Marker[] = descriptions.map(description => ({ elementId: description, kind: 'error', label: description, description }));
   return SetMarkersAction.create(set, { reason });
}

/** The messages the Problems view shows for `document`. */
function problemMessages(document: vscode.CustomDocument): string[] | undefined {
   return problems.get(document.uri)?.map(problem => problem.message);
}

function shown(): unknown[] {
   return vscodeStub.window.showErrorMessage.mock.calls.map(call => call[0]);
}

/** A write to `/a.x` refused, as its staging file with the uuid ending in `uuidTail` reports it. */
function denied(uuidTail: string): { uri: string; reason: string }[] {
   return [{ uri: 'file:///a.x', reason: `EACCES: permission denied, open '/a.x.4242.0000000${uuidTail}.tmp'` }];
}

/** The server's notification for a save it rejected with a `SaveFailedError` for `failures`, as `handleProcessError` sends it. */
function notice(failures: { uri: string; reason: string }[]): MessageAction {
   const error = new SaveFailedError(failures);
   return MessageAction.create(error.message, { severity: 'ERROR', details: String(error) });
}

/** The server's rejection of `request` with an error that is not typed. */
function untypedReject(request: SentMessage): RejectAction {
   return RejectAction.create('Failed to handle request', { responseId: request.action.requestId, detail: 'Error: boom' });
}

/** The server's rejection of `request` with a `SaveFailedError` for `failures`. */
function reject(request: SentMessage, failures: { uri: string; reason: string }[]): RejectAction {
   const detail = JSON.stringify(new SaveFailedError(failures).toJson());
   return RejectAction.create('Failed', { responseId: request.action.requestId, detail });
}

type SaveOutcome = 'saved' | 'typed' | 'untyped' | 'timeout';

describe('two saves of one diagram, answered in either order', () => {
   const advertised = [RequestSaveModelAction.KIND, SaveModelAction.KIND];
   const failures = [{ uri: 'file:///a.x', reason: 'EACCES' }];
   const typedToast = new SaveFailedError(failures).message;
   const untypedNotice = "Could not process action: 'save";
   const timeoutToast = 'Save operation timed out';
   const outcomes: SaveOutcome[] = ['saved', 'typed', 'untyped', 'timeout'];

   /**
    * The toasts `answers` show, each answer a save's place in the order sent
    * and its outcome. The server's notice of an untyped rejection always
    * shows. Otherwise only the latest save whose outcome was taken changes
    * what is shown, and a failure shows once until another outcome replaces it.
    */
   function expectedToasts(answers: [number, SaveOutcome][]): string[] {
      const toasts: string[] = [];
      let latest = -1;
      let shownToast: string | undefined;
      for (const [save, outcome] of answers) {
         if (outcome === 'untyped') {
            toasts.push(untypedNotice);
         }
         if (save < latest) {
            continue;
         }
         latest = save;
         const toast = outcome === 'typed' ? typedToast : outcome === 'timeout' ? timeoutToast : undefined;
         if (toast !== undefined && toast !== shownToast) {
            toasts.push(toast);
         }
         shownToast = toast;
      }
      return toasts;
   }

   for (const earlier of outcomes) {
      for (const later of outcomes) {
         for (const laterFirst of [false, true]) {
            it(`${earlier} then ${later}, the ${laterFirst ? 'later' : 'earlier'} answering first`, async () => {
               vi.useFakeTimers();
               const { connector, document, toServer, toWebview, fromServer } = setUp(advertised);
               const settle = (saving: Promise<void>): Promise<string> =>
                  saving.then(
                     () => 'saved',
                     () => 'rejected'
                  );
               const saves = [settle(connector.saveDocument(document))];
               await vi.advanceTimersByTimeAsync(10_000);
               saves.push(settle(connector.saveDocument(document)));
               const planned = [earlier, later];
               const order = laterFirst ? [1, 0] : [0, 1];
               const answers: [number, SaveOutcome][] = [];
               const answer = (save: number, outcome: Exclude<SaveOutcome, 'timeout'>): void => {
                  const request = toServer[save];
                  if (outcome === 'saved') {
                     fromServer({ clientId: 'client-1', action: ModelSavedAction.create({ responseId: request.action.requestId }) });
                  } else if (outcome === 'typed') {
                     fromServer({ clientId: 'client-1', action: reject(request, failures) });
                     fromServer({ clientId: 'client-1', action: notice(failures) });
                  } else {
                     fromServer({ clientId: 'client-1', action: untypedReject(request) });
                     fromServer({ clientId: 'client-1', action: MessageAction.create(untypedNotice, { severity: 'ERROR' }) });
                  }
                  answers.push([save, outcome]);
               };

               for (const save of order) {
                  const outcome = planned[save];
                  if (outcome !== 'timeout') {
                     answer(save, outcome);
                  }
               }
               // Each runs out 20 s after it was sent, the earlier first.
               for (const save of [0, 1]) {
                  await vi.advanceTimersByTimeAsync(10_000);
                  if (planned[save] === 'timeout') {
                     answers.push([save, 'timeout']);
                  }
               }
               // A server that answers a timed-out save at all answers it late, and with what failed.
               for (const save of order) {
                  if (planned[save] === 'timeout') {
                     answer(save, 'typed');
                  }
               }

               expect(shown()).toEqual(expectedToasts(answers));
               expect(toWebview).toEqual([]);
               expect(await Promise.all(saves)).toEqual(planned.map(outcome => (outcome === 'saved' ? 'saved' : 'rejected')));
               expect(connector.heldState()).toMatchObject({ rejected: 0 });
            });
         }
      }
   }
});
