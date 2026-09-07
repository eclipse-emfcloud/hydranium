/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   startLanguageServer as startLangiumLanguageServer,
   type LangiumSharedServices,
   type ServiceRequirements
} from '@hydranium/langium/lsp';
import { HydraniumDocumentUpdateHandler } from './hydranium-document-update-handler.js';

/**
 * Fail the LSP head's start when its shared module was never composed.
 *
 * **The composition mistake this catches.** `lsp.DocumentUpdateHandler` is a
 * SHARED slot, so the head binds it in `createLspServerSharedModule` — a
 * separate module from `createLspServerLanguageModule`. An adopter who adds
 * only the language module gets a server that boots, links and serves
 * completion, and quietly runs Langium's `DefaultDocumentUpdateHandler`: echo
 * suppression for the server's own writes, the `didChangeContent` debounce,
 * `markNextReason` stamping and the last-client-close rebuild are all absent,
 * with nothing in the log to say so.
 *
 * The type system does not catch it. `createIntegrationServices` returns
 * `inject(...) as unknown as TShared`, so widening `TShared` with
 * `LspServerAddedSharedServices` while omitting the module type-checks and
 * leaves the slot holding Langium's default.
 *
 * Checked with `instanceof`, so an adopter subclass of
 * {@link HydraniumDocumentUpdateHandler} — the documented way to extend the
 * handler — passes.
 *
 * Skips silently when no connection is bound: that is a more fundamental
 * misconfiguration, and Langium reports it immediately afterwards in its own
 * vocabulary. Reporting it here as a missing module would misname it.
 */
export function assertLspHeadComposed(services: LangiumSharedServices): void {
   if (!services.lsp?.Connection) {
      return;
   }
   const handler = services.lsp.DocumentUpdateHandler;
   if (!(handler instanceof HydraniumDocumentUpdateHandler)) {
      throw new Error(
         '[hydranium] the LSP head is starting without its shared module: `lsp.DocumentUpdateHandler` holds ' +
            `'${handler?.constructor?.name ?? 'nothing'}' rather than a HydraniumDocumentUpdateHandler. Echo suppression for ` +
            "the server's own writes, the didChangeContent debounce, build-reason stamping and the last-client-close rebuild " +
            'are all inert in that state. Add `createLspServerSharedModule(context)` to the shared tier — as ' +
            '`sharedModules.extra` when composing through `createIntegrationServices`, or as an `inject(...)` argument ' +
            'after `createServerSharedModule(context)`.'
      );
   }
}

/**
 * The framework's LSP server entry point: {@link assertLspHeadComposed}, then
 * Langium's `startLanguageServer` unchanged. Signature-compatible with
 * Langium's, so it is a drop-in for adopters importing from
 * `@hydranium/core/lsp`.
 */
export function startLanguageServer(services: LangiumSharedServices, serviceRequirements: Partial<ServiceRequirements> = {}): void {
   assertLspHeadComposed(services);
   startLangiumLanguageServer(services, serviceRequirements);
}
