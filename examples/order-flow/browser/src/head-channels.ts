/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * This host's own messages on the worker global, shared by both ends so
 * neither can drift from the other.
 *
 * The handshake itself, the bootstrap that hands each head its own port and
 * the worker's failure reports, is the framework's, in `@hydranium/protocol`,
 * and the page's end of it is `@hydranium/client-browser`'s. What is here is
 * what this host adds beside it: the workspace the heads came up on, and a
 * reset. None of it is any head's protocol, which is the line to keep: a
 * message that belongs to a head belongs on that head's port.
 */

/**
 * Workspace root the seeded filesystem is keyed under, and the folder the page
 * reports in `initialize`. Shared rather than restated on each side: a mismatch
 * produces an empty workspace and no error — the server initialises fine, walks
 * a folder it has no files for, and reports zero diagnostics for a workspace
 * that has several.
 */
export const WORKSPACE_ROOT_URI = 'file:///order-flow';

/** Workspace content keyed by path relative to {@link WORKSPACE_ROOT_URI}. */
export type WorkspaceFiles = Readonly<Record<string, string>>;

/**
 * Discriminator of the worker's answer to bootstrap: the workspace the heads
 * actually came up on.
 *
 * # Why the page is TOLD the content instead of reading the seed
 *
 * The generated seed is what the filesystem starts from, not what it holds. Once
 * stored edits are laid over it, the two differ — and a `didOpen` carries the
 * client's text as authoritative, so a page that opened an editor on the seed
 * would OVERWRITE the restored document in the server's text store and undo the
 * reload it just performed. Nothing would report it: both sides parse, the
 * diagnostics agree, and only the content is a version old.
 *
 * So the worker's filesystem is the single source of truth for content and the
 * page derives its editor text from this message. Sending the whole workspace is
 * affordable because this one is a handful of small files; a host with a real
 * workspace wants a per-document read instead.
 */
export const WORKSPACE_READY_MESSAGE_TYPE = 'order-flow/workspace-ready';

export interface WorkspaceReadyMessage {
   readonly type: typeof WORKSPACE_READY_MESSAGE_TYPE;
   /** Every file the heads' filesystem holds, seed and stored edits merged. */
   readonly files: WorkspaceFiles;
   /** The subset that came out of storage, so the page can say a restore happened. */
   readonly restored: readonly string[];
}

export function isWorkspaceReadyMessage(value: unknown): value is WorkspaceReadyMessage {
   if (typeof value !== 'object' || value === null) {
      return false;
   }
   const candidate = value as Partial<WorkspaceReadyMessage>;
   return candidate.type === WORKSPACE_READY_MESSAGE_TYPE && typeof candidate.files === 'object' && candidate.files !== null;
}

/**
 * Discriminator of the page's request to forget every stored edit.
 *
 * Routed through the worker rather than performed in the page, even though both
 * ends could reach the same origin-scoped database: the filesystem has ONE owner
 * here, and a page that opened it directly would be a second writer to keep in
 * step with the first.
 */
export const RESET_WORKSPACE_MESSAGE_TYPE = 'order-flow/reset-workspace';

export interface ResetWorkspaceMessage {
   readonly type: typeof RESET_WORKSPACE_MESSAGE_TYPE;
}

export function isResetWorkspaceMessage(value: unknown): value is ResetWorkspaceMessage {
   return typeof value === 'object' && value !== null && (value as Partial<ResetWorkspaceMessage>).type === RESET_WORKSPACE_MESSAGE_TYPE;
}

/**
 * Discriminator of the worker's acknowledgement that the store is empty.
 *
 * The page reloads on it rather than clearing anything itself, which is what
 * makes a reset one code path instead of two: the live filesystem is not
 * rewritten in place, the next start simply restores nothing. Rewriting it in
 * place would leave the language server holding documents whose content it never
 * re-read.
 *
 * A failed clear reports a `WorkerErrorMessage` instead, so the page shows the
 * reason and stays on the workspace it has.
 */
export const WORKSPACE_RESET_MESSAGE_TYPE = 'order-flow/workspace-reset';

export interface WorkspaceResetMessage {
   readonly type: typeof WORKSPACE_RESET_MESSAGE_TYPE;
}

export function isWorkspaceResetMessage(value: unknown): value is WorkspaceResetMessage {
   return typeof value === 'object' && value !== null && (value as Partial<WorkspaceResetMessage>).type === WORKSPACE_RESET_MESSAGE_TYPE;
}
