/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Resolving Theia's global selection to an order-flow document URI.
 *
 * **Document-scoped, and that is the same decision `OrderFlowPropertiesModel`
 * already documents, seen from the shell side.** The data head is URI-keyed
 * throughout — `openModelDocument` / `getModelDocument` / `updateModelDocument`
 * all take a `uri`, and an update's `model` *is* the document root — so there is
 * no request that addresses a sub-element. Element-scoped properties would need
 * an addressing scheme the protocol does not have, not more selection glue.
 * That is why the diagram's `selectedElementsIDs` are deliberately ignored below
 * while its `sourceUri` is used.
 *
 * **Structural typeguards, no Theia imports.** Every shape recognised here is
 * matched by its own free-function guard rather than by
 * `FileSelection.is` / `Navigatable.is`, so this module stays browser-neutral
 * and testable with no DOM and no Theia container. The guards are narrow enough
 * that a foreign selection with a coincidental `uri` property still has to
 * produce an order-flow file extension before anything happens.
 */

/**
 * File extensions the order-flow language server owns.
 *
 * Restated here because the browser cannot import the server package. A unit
 * test in this package asserts the list against the generated
 * `*LanguageMetaData.fileExtensions` of every order-flow grammar, so adding a
 * grammar to the server cannot leave the panel silently declining its files.
 */
export const ORDER_FLOW_FILE_EXTENSIONS = ['.domain', '.layout', '.process'] as const;

/** Anything that can hand back its own resource URI — Theia's `Navigatable`. */
interface NavigatableLike {
   getResourceUri(): { toString(): string } | undefined;
}

function isNavigatableLike(candidate: unknown): candidate is NavigatableLike {
   return typeof (candidate as NavigatableLike | undefined)?.getResourceUri === 'function';
}

/** The `{ uri }` shape Theia's tab bar publishes for a `NavigatableWidget`. */
interface UriHolder {
   uri: { toString(): string } | undefined;
}

function isUriHolder(candidate: unknown): candidate is UriHolder {
   const uri = (candidate as UriHolder | undefined)?.uri;
   return typeof uri === 'object' && uri !== null && typeof uri.toString === 'function';
}

/** One entry of the navigator's selection — Theia's `FileSelection`. */
interface FileSelectionLike {
   fileStat: { resource: { toString(): string } };
}

function isFileSelectionLike(candidate: unknown): candidate is FileSelectionLike {
   const resource = (candidate as FileSelectionLike | undefined)?.fileStat?.resource;
   return typeof resource === 'object' && resource !== null && typeof resource.toString === 'function';
}

/**
 * The selection `TheiaGLSPSelectionForwarder` publishes — GLSP's own
 * `GlspSelection`, matched structurally.
 *
 * It is already bound in every hydranium Theia diagram container: GLSP's
 * `theiaSelectModule` is part of `THEIA_DEFAULT_MODULES`, which
 * `initializeDiagramContainer` loads. So the diagram publishes its `sourceUri`
 * on selection *and* on focus change with no wiring of ours — which is what
 * lets a document-scoped panel follow the open diagram without this shell
 * owning any selection glue.
 */
interface GlspSelectionLike {
   selectedElementsIDs: string[];
   sourceUri?: string;
}

function isGlspSelectionLike(candidate: unknown): candidate is GlspSelectionLike {
   return Array.isArray((candidate as GlspSelectionLike | undefined)?.selectedElementsIDs);
}

/** Whether `uri` names a file one of the order-flow grammars owns. */
export function isOrderFlowUri(uri: string): boolean {
   return ORDER_FLOW_FILE_EXTENSIONS.some(extension => uri.endsWith(extension));
}

/**
 * The order-flow document URI `selection` refers to, or `undefined`.
 *
 * Recognises the four shapes Theia actually puts on `SelectionService` for a
 * document: the diagram's `GlspSelection`, the navigator's `FileSelection[]`,
 * a focused `Navigatable`, and the tab bar's `{ uri }`. Anything else — and any
 * URI that is not an order-flow file — yields `undefined`, which is what makes
 * the provider decline rather than show an empty panel over someone else's
 * selection.
 *
 * A `GlspSelection` with an empty `selectedElementsIDs` still resolves: the
 * forwarder publishes one every time the diagram takes focus with nothing
 * selected, and that is precisely when the panel should show the document.
 */
export function orderFlowUriOf(selection: unknown): string | undefined {
   const uri = resolveUri(selection);
   return uri !== undefined && isOrderFlowUri(uri) ? uri : undefined;
}

function resolveUri(selection: unknown): string | undefined {
   if (selection === undefined || selection === null) {
      return undefined;
   }
   // Checked before the array branch: a `GlspSelection` is a plain object, but
   // ordering the cheap discriminator first keeps the common case (a diagram
   // that has focus) off the array path entirely.
   if (isGlspSelectionLike(selection)) {
      return selection.sourceUri;
   }
   if (Array.isArray(selection)) {
      // The navigator publishes a `TreeWidgetSelection`, which is an array of
      // tree nodes; only the first entry is meaningful for a panel that shows
      // one document. Theia's own `ResourcePropertyDataService` reads
      // `selection[0]` the same way.
      const first: unknown = selection[0];
      return isFileSelectionLike(first) ? first.fileStat.resource.toString() : undefined;
   }
   if (isNavigatableLike(selection)) {
      return selection.getResourceUri()?.toString();
   }
   if (isUriHolder(selection)) {
      return selection.uri?.toString();
   }
   return undefined;
}
