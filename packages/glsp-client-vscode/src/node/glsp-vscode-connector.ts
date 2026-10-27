/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   ActionMessage,
   GlspVscodeConnector,
   type GlspVscodeClient,
   type Marker,
   MessageAction,
   MessageOrigin,
   type MessageProcessingResult,
   RejectAction,
   RequestAction,
   ResponseAction,
   type SetMarkersAction
} from '@eclipse-glsp/vscode-integration';
import { isSaveFailedError, reviveProtocolErrorJson, RequestSaveModelAction } from '@hydranium/protocol';
import * as vscode from 'vscode';

/** The `.<pid>.<uuid>.tmp` the core's `NodeFileSystemProvider` appends to the file it stages a write in. */
const STAGING_FILE_SUFFIX = /\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp/g;

/**
 * A `GlspVscodeConnector` whose every save is a request the server answers.
 *
 * GLSP's sends a `SaveModelAction`, which the server does not answer, and
 * resolves the save on the next dirty-state change the server reports as a
 * save. A failed save reports none, so the save never settles and VS Code
 * shows only the server's generic notification. A later save that succeeds
 * then resolves it as saved. Here each save sends a `RequestSaveModelAction`
 * and settles on the response to that request only: it resolves when the
 * server has saved, rejects when the server rejects it, and rejects when
 * {@link saveTimeout} runs out. A save that could not write some of its
 * documents rejects with a `SaveFailedError` naming each one and why.
 *
 * VS Code shows a rejected save only when the user started it, not an
 * auto-save, and the connector cannot tell the two apart. So for a typed
 * rejection, one whose detail is any JSON-RPC error envelope, such as a
 * `SaveFailedError`'s, and for a timeout, the connector shows the failure
 * itself, once until a save of that diagram succeeds or it fails for another
 * reason. A typed rejection's toast replaces the notification the server
 * sends with it. Any other rejection leaves the server's notification to say
 * it. An earlier save that answers after a later one adds no toast and
 * changes nothing the connector shows, though the server's notification of
 * an untyped rejection still appears.
 *
 * Against a server that does not advertise the request, the save is GLSP's.
 *
 * Its Problems view shows every marker reason at once, as the diagram does.
 * GLSP's replaces a document's problems with each `SetMarkersAction` whatever
 * its reason, so the last reason sent wins, and a Validate answered under
 * batch erases the live markers. This one keeps each client's latest set per
 * reason and shows their union. The diagram still gets every action unchanged.
 */
export class HydraniumGlspVscodeConnector<D extends vscode.CustomDocument = vscode.CustomDocument> extends GlspVscodeConnector<D> {
   /** How long a save waits for the server's response before it rejects, as the Theia saveable does. */
   protected saveTimeout = 20_000;
   /** The saves sent and not yet settled, by request id, each with its place in the order saves were sent. */
   protected readonly pendingSaves = new Map<
      string,
      { readonly clientId: string; readonly order: number; resolve(): void; reject(reason: unknown): void }
   >();
   /**
    * The saves that timed out, by request id, to the client they were for, so
    * a late response is handled as a save's rather than sent to the webview: a
    * typed rejection is still shown in place of the server's notification.
    * Holds the {@link abandonedSaveLimit} latest, since a server may never
    * answer.
    */
   protected readonly abandonedSaves = new Map<string, { readonly clientId: string; readonly order: number }>();
   protected abandonedSaveLimit = 64;
   /** How many saves were sent, which orders them. */
   protected sentSaves = 0;
   /**
    * For each client, the order of the latest save whose outcome was taken,
    * so a slower, earlier save's cannot replace what a later one showed.
    */
   protected readonly latestSaveOutcomes = new Map<string, number>();
   /**
    * For each client whose save the server rejected with a typed error, that
    * error's message, which the details of the server's notification for it
    * carry.
    */
   protected readonly rejectedSaveMessages = new Map<string, string>();
   /** The failure last shown for each client, by {@link saveFailureKey}, until a later save succeeds or fails otherwise. */
   protected readonly shownSaveFailures = new Map<string, string>();
   /** Each client's latest markers, keyed by client id, then by reason. */
   protected readonly markersByReason = new Map<string, Map<string, Marker[]>>();

   override saveDocument(document: D, destination?: vscode.Uri): Promise<void> {
      const clientId = this.documentMap.get(document);
      const client = clientId === undefined ? undefined : this.clientMap.get(clientId);
      if (!client?.webviewEndpoint.serverActions?.includes(RequestSaveModelAction.KIND)) {
         return super.saveDocument(document, destination);
      }
      const requestId = RequestAction.generateRequestId();
      const save = { clientId: client.clientId, order: ++this.sentSaves };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const saving = new Promise<void>((resolve, reject) => {
         this.pendingSaves.set(requestId, { ...save, resolve, reject });
         timer = setTimeout(() => {
            this.abandonSave(requestId, save);
            const timedOut = new Error('Save operation timed out');
            reject(timedOut);
            if (this.takeSaveOutcome(save)) {
               this.showSaveFailure(save.clientId, timedOut);
            }
         }, this.saveTimeout);
      }).finally(() => {
         clearTimeout(timer);
         this.pendingSaves.delete(requestId);
      });
      const action = RequestSaveModelAction.create({ requestId, fileUri: destination?.path });
      this.options.server.onSendToServerEmitter.fire({ clientId: client.clientId, action });
      return saving;
   }

   /**
    * Settles a pending save on its response, which the webview does not get,
    * and drops the server's error notification for a typed rejection of it.
    */
   protected override processMessage(message: unknown, origin: MessageOrigin): MessageProcessingResult {
      if (origin !== MessageOrigin.SERVER || !ActionMessage.is(message)) {
         return super.processMessage(message, origin);
      }
      const rejected = this.rejectedSaveMessages.get(message.clientId);
      if (
         rejected !== undefined &&
         MessageAction.is(message.action) &&
         message.action.severity === 'ERROR' &&
         message.action.details?.includes(rejected)
      ) {
         this.rejectedSaveMessages.delete(message.clientId);
         return { processedMessage: undefined, messageChanged: true };
      }
      if (!ResponseAction.hasValidResponseId(message.action)) {
         return super.processMessage(message, origin);
      }
      const response = message.action;
      const pending = this.pendingSaves.get(response.responseId);
      const save = pending ?? this.abandonedSaves.get(response.responseId);
      if (save === undefined) {
         return super.processMessage(message, origin);
      }
      this.abandonedSaves.delete(response.responseId);
      const latest = this.takeSaveOutcome(save);
      if (RejectAction.is(response)) {
         const typed = response.detail === undefined ? undefined : reviveProtocolErrorJson(response.detail);
         pending?.reject(typed ?? new Error(response.message));
         if (typed) {
            this.rejectedSaveMessages.set(save.clientId, typed.message);
         }
         if (typed && latest) {
            this.showSaveFailure(save.clientId, typed);
         } else if (latest) {
            // The server's notification says this one.
            this.shownSaveFailures.delete(save.clientId);
         }
      } else {
         pending?.resolve();
         this.rejectedSaveMessages.delete(save.clientId);
         if (latest) {
            this.shownSaveFailures.delete(save.clientId);
         }
      }
      return { processedMessage: undefined, messageChanged: true };
   }

   /** Show the union of the client's latest set for each reason in the Problems view. */
   protected override handleSetMarkersAction(
      message: ActionMessage<SetMarkersAction>,
      client: GlspVscodeClient<D> | undefined,
      origin: MessageOrigin
   ): MessageProcessingResult {
      if (!client) {
         return super.handleSetMarkersAction(message, client, origin);
      }
      let byReason = this.markersByReason.get(client.clientId);
      if (!byReason) {
         byReason = new Map();
         this.markersByReason.set(client.clientId, byReason);
      }
      byReason.set(message.action.reason ?? '', message.action.markers);
      const union = { ...message, action: { ...message.action, markers: [...byReason.values()].flat() } };
      super.handleSetMarkersAction(union, client, origin);
      return { processedMessage: message, messageChanged: false };
   }

   override async registerClient(client: GlspVscodeClient<D>): Promise<void> {
      const listener = client.webviewEndpoint.webviewPanel.onDidDispose(() => {
         listener.dispose();
         this.forgetClient(client.clientId);
      });
      return super.registerClient(client);
   }

   /** End what is held for `clientId`'s diagram once it is closed. Its pending saves will not be answered. */
   protected forgetClient(clientId: string): void {
      for (const pending of this.pendingSaves.values()) {
         if (pending.clientId === clientId) {
            pending.reject(new Error('Save cancelled: the diagram was closed'));
         }
      }
      for (const [requestId, abandoned] of this.abandonedSaves) {
         if (abandoned.clientId === clientId) {
            this.abandonedSaves.delete(requestId);
         }
      }
      this.latestSaveOutcomes.delete(clientId);
      this.rejectedSaveMessages.delete(clientId);
      this.shownSaveFailures.delete(clientId);
      this.markersByReason.delete(clientId);
   }

   /** Whether `save`'s outcome is the latest of its client's taken so far, taking it if so. */
   protected takeSaveOutcome(save: { readonly clientId: string; readonly order: number }): boolean {
      if (save.order < (this.latestSaveOutcomes.get(save.clientId) ?? 0)) {
         return false;
      }
      this.latestSaveOutcomes.set(save.clientId, save.order);
      return true;
   }

   /** Record a timed-out save, dropping the oldest past {@link abandonedSaveLimit}. */
   protected abandonSave(requestId: string, save: { readonly clientId: string; readonly order: number }): void {
      this.abandonedSaves.set(requestId, save);
      for (const oldest of this.abandonedSaves.keys()) {
         if (this.abandonedSaves.size <= this.abandonedSaveLimit) {
            break;
         }
         this.abandonedSaves.delete(oldest);
      }
   }

   /** Show `failure` for `clientId`'s diagram, unless it is the one shown since its last successful save. */
   protected showSaveFailure(clientId: string, failure: Error): void {
      const key = this.saveFailureKey(failure);
      if (this.shownSaveFailures.get(clientId) !== key) {
         this.shownSaveFailures.set(clientId, key);
         void vscode.window.showErrorMessage(failure.message);
      }
   }

   /**
    * What makes two failures the same to the user: each document that failed
    * and why, without the name of the staging file a disk write gives each
    * attempt.
    */
   protected saveFailureKey(failure: Error): string {
      return isSaveFailedError(failure)
         ? JSON.stringify(failure.failures.map(({ uri, reason }) => [uri, reason.replace(STAGING_FILE_SUFFIX, '')]))
         : failure.message;
   }

   override dispose(): void {
      for (const pending of this.pendingSaves.values()) {
         pending.reject(new Error('Save cancelled: the connector was disposed'));
      }
      this.abandonedSaves.clear();
      this.latestSaveOutcomes.clear();
      this.rejectedSaveMessages.clear();
      this.shownSaveFailures.clear();
      this.markersByReason.clear();
      super.dispose();
   }
}
