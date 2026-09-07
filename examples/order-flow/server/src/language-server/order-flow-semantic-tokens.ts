/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   AbstractHydraniumSemanticTokenProvider,
   type HydraniumSemanticTokenProviderOptions,
   type SemanticTokenKind
} from '@hydranium/core/lsp';
import type { ServerLanguageServices } from '@hydranium/core';
import { SemanticTokenTypes } from 'vscode-languageserver';
import {
   Branch,
   Entity,
   Enumeration,
   EnumLiteral,
   Field,
   Gateway,
   ProcessModel,
   ProjectManifest,
   Task,
   ValueType
} from './generated/ast.js';

/**
 * AST-aware highlighting for all three order-flow grammars, as ONE map.
 *
 * One class rather than three because the map is keyed by `$type` and the three
 * grammars share a single `AstReflection` — so a `.process` file's
 * `[Entity:ID]` reference resolves its colour from the same entry that colours
 * the `.domain` declaration it points at. That is the property worth
 * demonstrating: cross-grammar references stay consistently coloured without
 * either grammar knowing about the other's provider.
 *
 * **What is deliberately absent, and why each absence is correct rather than an
 * oversight.** `Read` / `Write` / `TypeReference` carry only cross-references
 * and declare nothing, so their references are already coloured from their
 * targets' entries. `DiagramNode` has no name property at all, so the base's
 * declaration branch could not fire for it even with an entry, and nothing
 * references the type. `DomainModel` / `LayoutModel` are named roots, left
 * uncoloured because a whole-file root reads as noise in the gutter.
 *
 * A missing entry means only "no kind of its own"; what the reader then sees is
 * the HOST's business. The VS Code and Theia extensions ship
 * `.tmLanguage.json` grammars, so an uncoloured span keeps its TextMate colour
 * there. The browser page ships no grammar at all and passes
 * `highlightKeywords` instead, which is why `process` and `for` are blue on
 * that page and left to TextMate everywhere else.
 *
 * `Branch` maps to a kind although its name property is `label`, not `name`: the
 * base reads the property from the `NameProvider` rather than assuming `name`,
 * so the entry works either way. It is kept as the case that proves the
 * indirection is load-bearing.
 */
export class OrderFlowSemanticTokenProvider extends AbstractHydraniumSemanticTokenProvider {
   /**
    * Forwarded verbatim, so the HOST composing this server decides whether
    * keywords are coloured. Spelled out although TypeScript would inherit the
    * same signature: it is the seam an adopter copies, and the moment such a
    * subclass acquires a constructor of its own for any other reason, dropping
    * the second parameter here pins every host to the framework default with
    * no error anywhere.
    */
   constructor(services: ServerLanguageServices, options: HydraniumSemanticTokenProviderOptions = {}) {
      super(services, options);
   }

   /**
    * The whole adopter contribution: a `$type` in, a token kind out. The
    * framework base derives the declaration's name property from the
    * `NameProvider` and discovers every cross-reference with `streamReferences`,
    * so there is no walk, no typeguard chain and no per-property `index`
    * bookkeeping to get wrong here.
    */
   protected override getTokenKind(type: string): SemanticTokenKind | undefined {
      switch (type) {
         // Structural declarations. `Entity` and `ValueType` are both types a
         // field can be declared as, so they share a kind — a reference does not
         // reveal which it resolved to, and colouring them apart would make the
         // same `Field.type` flicker between kinds as the target changed.
         case Entity.$type:
         case ValueType.$type:
            return SemanticTokenTypes.class;
         case Enumeration.$type:
            return SemanticTokenTypes.enum;
         case EnumLiteral.$type:
            return SemanticTokenTypes.enumMember;
         case Field.$type:
            return SemanticTokenTypes.property;

         // Process flow. `Task` and `Gateway` are the two `FlowNode`s, and both
         // a `Transition` and a `Branch` reference `FlowNode` rather than either
         // concrete type — so, as with the declarations above, they must agree.
         case Task.$type:
         case Gateway.$type:
            return SemanticTokenTypes.function;
         case Branch.$type:
            return SemanticTokenTypes.label;
         case ProcessModel.$type:
            return SemanticTokenTypes.namespace;

         // The project header. `namespace` rather than a declaration kind
         // because the manifest names the enclosing project, not a model
         // element, and its `requires` entries are plain strings the project
         // manager reads at load time — never cross-references, so nothing
         // points at this name.
         case ProjectManifest.$type:
            return SemanticTokenTypes.namespace;

         default:
            return undefined;
      }
   }
}
