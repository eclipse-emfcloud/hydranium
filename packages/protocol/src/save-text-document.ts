/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { RequestType } from 'vscode-jsonrpc';

/**
 * LSP's `VersionedTextDocumentIdentifier`, declared field by field: this
 * package carries no LSP dependency, and the fields are LSP's own.
 */
export interface SaveTextDocumentParams {
   readonly textDocument: { readonly uri: string; readonly version: number };
}

/**
 * Ask the LSP head to persist the text it holds for a document, which it
 * answers with `null` once the text is written. LSP itself has none: its
 * `didSave` reports a write the editor made, so a host whose files only the
 * server holds saves through this.
 *
 * It travels the connection the `didChange`s travel, so it arrives after
 * them. The server refuses it with a `ConflictError` unless the version is the
 * one the editor last declared and its buffer holds the server's current
 * text, which a `workspace/applyEdit` still in flight breaks.
 *
 * A server that answers it advertises it as
 * `ServerCapabilities.experimental[SaveTextDocumentRequest.method] = true`;
 * a client checks that before sending, since a server without a handler
 * answers `MethodNotFound`.
 */
export namespace SaveTextDocumentRequest {
   export const method = 'hydranium/saveTextDocument';
   export const type = new RequestType<SaveTextDocumentParams, null, void>(method);
}
