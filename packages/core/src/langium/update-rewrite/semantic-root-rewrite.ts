/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type TransferElement } from '@hydranium/protocol';

/**
 * Applies `rewrite` to the ONE populated semantic slot of a wrapper-shaped
 * transfer root, reassembling the wrapper around the result.
 *
 * The transfer-side counterpart to `NameBasedKeyProvider.isSemanticRoot`'s
 * "wrapper grammars with an unnamed root node" case: the document root is a
 * discriminating wrapper carrying one populated slot per semantic type
 * (`{ entity }` or `{ mapping }` or `{ diagram }`, never two), and an
 * `UpdateRewrite` is handed that wrapper while the fields it cares about
 * live one level down.
 *
 * `semanticKeys` is supplied rather than inferred: which slots a wrapper may
 * carry is grammar knowledge, and sniffing "the single object-valued property"
 * would silently pick up any object-valued metadata a root grows later.
 *
 * **Identity is the no-op signal, and it is load-bearing.** When no slot is
 * populated, or `rewrite` hands back the same reference it was given, the
 * ARGUMENT is returned — not a copy. An `UpdateRewrite` chain folds every
 * rewrite over the model, so a rewrite that does not apply must be free; a
 * defensive copy here would make every unrelated write allocate a fresh root per
 * registered rewrite. Callers that compare with `===` to detect "nothing
 * happened" depend on this too.
 *
 * Rewrites of an unwrapped grammar — where the named root element IS the
 * semantic root — do not need this helper: their model is already the node.
 */
export function rewriteSemanticRoot<TTransfer extends TransferElement>(
   model: TTransfer,
   semanticKeys: readonly string[],
   rewrite: (semanticRoot: Record<string, unknown>, key: string) => Record<string, unknown>
): TTransfer {
   const record = model as unknown as Record<string, unknown>;
   const semanticKey = semanticKeys.find(key => record[key]);
   if (!semanticKey) {
      return model;
   }
   const semanticRoot = record[semanticKey] as Record<string, unknown> | undefined;
   if (!semanticRoot) {
      return model;
   }
   const rewritten = rewrite(semanticRoot, semanticKey);
   if (rewritten === semanticRoot) {
      return model;
   }
   return { ...record, [semanticKey]: rewritten } as unknown as TTransfer;
}
