/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The example's AST entry point. Re-exports the single combined AST that one
 * `langium-cli` run over all THREE grammars emits — `Domain`, `Process` and
 * `Layout` types live in the same module and share one
 * `OrderFlowAstReflection`, which is what makes the cross-grammar references in
 * `process.langium` (`.process` → `.domain`) and `layout.langium` (`.layout` →
 * `.process`) resolvable at all.
 *
 * Adopter code imports from HERE rather than from `./generated/ast.js`, so the
 * AST augmentations below travel with every import of the AST.
 *
 * Both properties are populated by `OrderFlowComputedPropertiesContribution`
 * at `ComputedScopes`. `_writtenFields` is the cross-grammar one: a `.process`
 * node carrying `.domain` nodes, which is why it is declared here rather than
 * in either grammar.
 */

declare module './generated/ast.js' {
   interface Task {
      /** @derived The `.domain` fields this task's write effects resolve to, in effect order. */
      readonly _writtenFields?: Field[];
      /** @derived One-line rendering of the task's effects, e.g. `writes status=PAID (OrderStatus)`. */
      readonly _effectSummary?: string;
   }
}

export * from './generated/ast.js';
