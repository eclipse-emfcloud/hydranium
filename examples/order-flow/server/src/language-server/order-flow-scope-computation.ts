/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type HydraniumAstNodeDescriptionProvider, HydraniumScopeComputation, type NameProvider } from '@hydranium/core';
import type { AstNode, AstNodeDescription, LangiumDocument } from '@hydranium/langium';
import { isEntity, isEnumeration, isValueType } from './ast.js';

/**
 * True iff `node` is a `.domain` declaration the grammar marked `public`.
 * The three declaration kinds each carry the optional modifier
 * independently, so the check is a union rather than a common supertype.
 */
export function isPubliclyVisible(node: AstNode): boolean {
   if (isEntity(node) || isValueType(node) || isEnumeration(node)) {
      return node.visibility === 'public';
   }
   return false;
}

/**
 * Order-flow scope computation. Turns the grammar's `public` modifier into
 * the framework's `public` visibility tier.
 *
 * The framework default emits a `tier: 'public'` sibling whenever the
 * project-qualified name differs from the document-qualified one — a
 * name-shape test, which is the right default for adopters that write
 * cross-project references as `<project>.<element>`. Order-flow writes them
 * as the bare name (its projects are `UNQUALIFIED_PROJECT_REFERENCE`), so
 * the two names coincide and the default would never emit the public tier
 * at all.
 *
 * This override replaces the name-shape test with a **declared-visibility**
 * test: emit the public-tier sibling, at the same document-qualified name,
 * only for declarations the author marked `public`. Everything else keeps
 * only the `tier: 'project'` description the framework default already
 * emitted, so it stays invisible to other projects — including to their
 * completion proposals, since the candidate provider reads the same
 * filtered scope.
 *
 * That is what makes the `commerce-core` / `orders` pair a demonstration
 * rather than an assertion: `Money` is `public` and resolves from `orders`;
 * `AuditStamp` is not and does not.
 *
 * The two descriptions carry the same name, which is deliberate. Inside the
 * owning project the framework's own-project filter hides the public-tier
 * sibling and the project-tier one answers; from a dependent project the
 * project-tier one is hidden and the public-tier one answers. One name, one
 * visible entry either way.
 */
export class OrderFlowScopeComputation extends HydraniumScopeComputation {
   protected override exportPublic(node: AstNode, exports: AstNodeDescription[], document: LangiumDocument): void {
      if (!isPubliclyVisible(node)) {
         return;
      }
      const projectId = this.getProjectIdForDocument(document);
      if (projectId === undefined) {
         return;
      }
      const documentName = (this.nameProvider as NameProvider).getDocumentQualifiedName(node);
      if (!documentName) {
         return;
      }
      const descriptions = this.descriptions as HydraniumAstNodeDescriptionProvider;
      exports.push(descriptions.createPublic({ node, name: documentName, document, projectId }));
   }
}
