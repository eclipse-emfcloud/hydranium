/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The handshake that hands each head its own channel into the worker, shared by
 * both ends so neither can drift from the other.
 *
 * # Why the heads get dedicated ports and never `self`
 *
 * All heads must see ONE Langium store, so they share ONE worker — and that is
 * what makes the worker's global message channel contended. A head bound to
 * `self` receives every message any other head's client sends, because
 * `BrowserMessageReader` filters nothing. Two heads on `self` is not a race that
 * shows up under load; it is every message delivered twice to the wrong reader.
 *
 * `self` is unusable even for a single head, because GLSP's `WorkerServerLauncher`
 * posts its startup handshake through the GLOBAL `postMessage` regardless of the
 * connection it was configured with — so a plain string arrives on `self` that no
 * JSON-RPC reader can parse. Leaving `self` to carry this file's own messages and
 * that stray string is what keeps every head's stream clean.
 *
 * The global therefore carries the HOST protocol: bootstrap out, the workspace
 * the heads came up on back, a workspace reset, and failure reports. None of it
 * is any head's protocol, which is the line to keep — a message that belongs to
 * a head belongs on that head's port.
 *
 * This is also why upstream's own `GLSPWebWorkerProvider` is not the page-side
 * piece here: it constructs the worker itself and reads the worker object
 * directly, which is one worker per head and the global on both ends. The page
 * builds a `MessageConnection` over its port instead and hands that to
 * `BaseJsonrpcGLSPClient`, which takes any `ConnectionProvider`.
 *
 * The cost of designing this in now is nothing; the cost of retrofitting it when
 * the second head arrives is every call site.
 */

/** Discriminator of the bootstrap message. The worker answers nothing else. */
export const BOOTSTRAP_MESSAGE_TYPE = 'order-flow/bootstrap';

/**
 * Workspace root the seeded filesystem is keyed under, and the folder the page
 * reports in `initialize`. Shared rather than restated on each side: a mismatch
 * produces an empty workspace and no error — the server initialises fine, walks
 * a folder it has no files for, and reports zero diagnostics for a workspace
 * that has several.
 */
export const WORKSPACE_ROOT_URI = 'file:///order-flow';

/** One transferred port per head. Heads are added here as slices land. */
export interface HeadPorts {
   readonly lsp: MessagePort;
   readonly data: MessagePort;
   readonly glsp: MessagePort;
}

export interface BootstrapMessage {
   readonly type: typeof BOOTSTRAP_MESSAGE_TYPE;
   readonly ports: HeadPorts;
}

export function isBootstrapMessage(value: unknown): value is BootstrapMessage {
   if (typeof value !== 'object' || value === null) {
      return false;
   }
   const candidate = value as Partial<BootstrapMessage>;
   return candidate.type === BOOTSTRAP_MESSAGE_TYPE && typeof candidate.ports === 'object' && candidate.ports !== null;
}

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
 * affordable because this one is eight small files; a host with a real workspace
 * wants a per-document read instead.
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
 * A failed clear sends {@link WorkerErrorMessage} instead, so the page shows the
 * reason and stays on the workspace it has.
 */
export const WORKSPACE_RESET_MESSAGE_TYPE = 'order-flow/workspace-reset';

export interface WorkspaceResetMessage {
   readonly type: typeof WORKSPACE_RESET_MESSAGE_TYPE;
}

export function isWorkspaceResetMessage(value: unknown): value is WorkspaceResetMessage {
   return typeof value === 'object' && value !== null && (value as Partial<WorkspaceResetMessage>).type === WORKSPACE_RESET_MESSAGE_TYPE;
}

/**
 * Discriminator of a failure report the worker sends back on the global channel.
 *
 * A worker has no console anyone is looking at, and the failures that matter
 * most here are the ones that reach nobody by default: an LSP *notification*
 * handler that rejects has no reply to reject, so a workspace walk that throws
 * looks exactly like a workspace with no documents in it — the page waits, the
 * server is idle, and nothing anywhere records why.
 */
export const WORKER_ERROR_MESSAGE_TYPE = 'order-flow/worker-error';

export interface WorkerErrorMessage {
   readonly type: typeof WORKER_ERROR_MESSAGE_TYPE;
   readonly phase: string;
   readonly message: string;
}

export function isWorkerErrorMessage(value: unknown): value is WorkerErrorMessage {
   if (typeof value !== 'object' || value === null) {
      return false;
   }
   const candidate = value as Partial<WorkerErrorMessage>;
   return candidate.type === WORKER_ERROR_MESSAGE_TYPE && typeof candidate.message === 'string';
}

/** Render an unknown thrown value, keeping the stack when there is one. */
export function formatError(error: unknown): string {
   if (error instanceof Error) {
      return error.stack ?? `${error.name}: ${error.message}`;
   }
   return String(error);
}
