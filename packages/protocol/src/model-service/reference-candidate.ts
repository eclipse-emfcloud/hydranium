/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { TransferElement } from '../transfer-element';

/**
 * UI-facing descriptor of an AST element that may be assigned as the value
 * of a reference. Carries the URI of the owning document, the AST type, the
 * display label, and the persisted reference value.
 *
 * Produced by the reference-candidate pipeline in `@hydranium/core`
 * (`ReferenceCandidateProvider.find`). Consumed by UI surfaces —
 * command-palettes, drop-target action providers, completion popups — that
 * present ranked, deduped reference candidates to the user.
 *
 * **Why two label fields**: `label` is what the user sees in the dropdown;
 * `value` is what gets persisted as the reference's `$refText` when the
 * user selects this element. Separating them lets the server present a
 * human-readable display name (e.g. `node.name`) while storing the
 * canonical reference identifier (e.g. `node.id`). Both fields are
 * required — producers without a display/value distinction set the same
 * string in both, so consumers never need to remember a fallback rule.
 */
export interface ReferenceCandidate {
   /** URI of the document declaring the referenced element. */
   uri: string;
   /** AST `$type` of the referenced element — useful for icon dispatch. */
   type: string;
   /** Display label shown to the user in dropdowns and chips. */
   label: string;
   /** String stored as `$refText` when the user selects this element. */
   value: string;
}

/**
 * Result of resolving a `ReferenceRequest` to its target — a
 * {@link ReferenceCandidate} plus the resolved node's transfer subtree.
 *
 * A candidate and a target are the same kind of thing (an addressable
 * reference target): `find` lists candidates, `resolveReference` returns the
 * one a value matched. The target additionally carries `element` because it
 * is a single result that can afford the payload, where candidates come as a
 * list and stay lightweight. The encoded `element` is just the resolved
 * node's subtree, NOT the whole document root — callers that want the full
 * document fetch it via `getModelDocument(uri)`.
 *
 * Generic over the transfer root type so adopters get their typed overlay.
 */
export interface ReferenceTarget<TTransfer extends TransferElement = TransferElement> extends ReferenceCandidate {
   /** The resolved target node, encoded as a transfer subtree. */
   element: TTransfer;
}
