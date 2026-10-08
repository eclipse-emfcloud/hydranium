/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   ApplyWorkspaceEditRequest,
   type ApplyWorkspaceEditParams,
   type ApplyWorkspaceEditResult,
   type ProtocolConnection,
   type WorkspaceEdit
} from 'vscode-languageserver-protocol/node';
import type { AppliedEdit, NextAppliedEditOptions } from './lsp-server-connection.js';

/**
 * The client side of `workspace/applyEdit` on one LSP connection, shared by the
 * in-process and the spawned tiers so their capture and wait cannot drift.
 */
export interface AppliedEditCapture {
   readonly appliedEdits: ReadonlyArray<AppliedEdit>;
   nextAppliedEdit(uri: string, timeoutMsOrOptions?: number | NextAppliedEditOptions): Promise<AppliedEdit>;
   setApplyEditHandler(handler: (params: ApplyWorkspaceEditParams) => ApplyWorkspaceEditResult): void;
   dispose(): void;
}

/**
 * Answer and record every `workspace/applyEdit` arriving on `client`.
 *
 * Register before the connection can receive one: `vscode-jsonrpc` keeps a
 * single handler per request type, so this must be the only `applyEdit`
 * handler on `client`, and a second registration displaces the capture.
 */
export function captureAppliedEdits(client: ProtocolConnection, defaultTimeoutMs: number): AppliedEditCapture {
   const appliedEdits: AppliedEdit[] = [];
   const waiters: Array<(edit: AppliedEdit) => boolean> = [];
   let handler: (params: ApplyWorkspaceEditParams) => ApplyWorkspaceEditResult = () => ({ applied: true });
   const subscription = client.onRequest(ApplyWorkspaceEditRequest.type, (params: ApplyWorkspaceEditParams) => {
      const edit: AppliedEdit = { params, uris: editedUris(params.edit), text: insertedText(params.edit) };
      // Record before the handler runs, so a handler that rejects the edit or
      // throws still leaves the push observable — the send is what the egress
      // assertion is about.
      appliedEdits.push(edit);
      for (const waiter of [...waiters]) {
         if (waiter(edit)) {
            const at = waiters.indexOf(waiter);
            if (at >= 0) {
               waiters.splice(at, 1);
            }
         }
      }
      return handler(params);
   });

   return {
      appliedEdits,

      nextAppliedEdit(uri: string, timeoutMsOrOptions?: number | NextAppliedEditOptions): Promise<AppliedEdit> {
         const options: NextAppliedEditOptions =
            typeof timeoutMsOrOptions === 'number' ? { timeoutMs: timeoutMsOrOptions } : (timeoutMsOrOptions ?? {});
         const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
         const { fromIndex, match } = options;
         const matches = (edit: AppliedEdit): boolean => edit.uris.includes(uri) && (match?.(edit) ?? true);
         if (fromIndex !== undefined) {
            // Replay from the capture first: the push may already have arrived,
            // and a waiter only ever sees later ones.
            const captured = appliedEdits.slice(Math.max(0, fromIndex)).find(matches);
            if (captured) {
               return Promise.resolve(captured);
            }
         }
         return new Promise<AppliedEdit>((resolve, reject) => {
            const waiter = (edit: AppliedEdit): boolean => {
               if (!matches(edit)) {
                  return false;
               }
               clearTimeout(timer);
               resolve(edit);
               return true;
            };
            const timer = setTimeout(() => {
               const at = waiters.indexOf(waiter);
               if (at >= 0) {
                  waiters.splice(at, 1);
               }
               reject(new Error(`Timed out waiting for a workspace/applyEdit addressing ${uri}`));
            }, timeoutMs);
            waiters.push(waiter);
         });
      },

      setApplyEditHandler(next: (params: ApplyWorkspaceEditParams) => ApplyWorkspaceEditResult): void {
         handler = next;
      },

      dispose(): void {
         subscription.dispose();
      }
   };
}

/** Every URI a {@link WorkspaceEdit} addresses, in `documentChanges` then `changes` order. */
function editedUris(edit: WorkspaceEdit): string[] {
   const uris: string[] = [];
   for (const change of edit.documentChanges ?? []) {
      if ('textDocument' in change) {
         uris.push(change.textDocument.uri);
      } else if ('oldUri' in change) {
         uris.push(change.oldUri, change.newUri);
      } else {
         uris.push(change.uri);
      }
   }
   uris.push(...Object.keys(edit.changes ?? {}));
   return uris;
}

/** Every text edit's `newText` in a {@link WorkspaceEdit}, concatenated in edit order. */
function insertedText(edit: WorkspaceEdit): string {
   const parts: string[] = [];
   for (const change of edit.documentChanges ?? []) {
      if ('edits' in change) {
         for (const textEdit of change.edits) {
            if ('newText' in textEdit) {
               parts.push(textEdit.newText);
            }
         }
      }
   }
   for (const textEdits of Object.values(edit.changes ?? {})) {
      for (const textEdit of textEdits) {
         parts.push(textEdit.newText);
      }
   }
   return parts.join('');
}
