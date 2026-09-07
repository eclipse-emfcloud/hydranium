/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractProjectManager } from '@hydranium/core';
import { type Project, UNQUALIFIED_PROJECT_REFERENCE } from '@hydranium/protocol';
import type { LangiumDocument, URI } from '@hydranium/langium';
import { isDomainModel } from './ast.js';

/**
 * Order-flow project manager. A project is a **folder**, declared by
 * whichever `.domain` file in it carries a `project` header:
 *
 * ```
 * commerce-core/
 *    money.domain       project commerce-core     <- the descriptor
 *    internal.domain
 * orders/
 *    orders.domain      project orders requires commerce-core
 *    fulfillment.process
 * ```
 *
 * **Why folder-scoped rather than file-scoped** (one project per file, the
 * other shape the contract allows): order-flow deliberately puts several files
 * in one project, and files of two different grammars in one project. That is
 * the layout a real adopter has, and it is the only layout under which the
 * framework's `getProject` closest-ancestor-descriptor-folder membership
 * rule does any work — with one project per file it is an identity map.
 *
 * **Why `isProjectDescriptor` matches every `.domain` file** rather than a
 * fixed filename: the predicate is URI-only by contract (it gates the
 * discovery walk before anything is parsed), so it cannot know which file
 * carries the header. Widening the predicate and returning `undefined` from
 * {@link parseProjectDescriptor} for headerless files puts the decision
 * where the content is available. `.process` and `.layout` files are never
 * descriptors — they carry no project header and inherit membership from their
 * folder.
 *
 * **Why `requires` is not a Langium cross-reference:** it is read during
 * workspace load, before any scope exists to resolve it against. The
 * bootstrap order is linear — discover descriptors, populate
 * `Project.dependencies`, then the framework's project-scope filter walks
 * them to decide cross-project visibility.
 *
 * `referenceName` is {@link UNQUALIFIED_PROJECT_REFERENCE}: cross-project
 * references in this language are written as the bare declaration name
 * (`Money`, not `commerce-core.Money`), so project-qualified and
 * document-qualified names coincide. What separates the two visibility
 * tiers here is the grammar's `public` modifier, not the name shape — see
 * `OrderFlowScopeComputation`.
 */
export class OrderFlowProjectManager extends AbstractProjectManager<Project> {
   override isProjectDescriptor(uri: URI | string): boolean {
      const path = typeof uri === 'string' ? uri : uri.path;
      return path.endsWith('.domain');
   }

   protected override async parseProjectDescriptor(uri: URI, document: LangiumDocument): Promise<Project | undefined> {
      if (document.parseResult.lexerErrors.length > 0 || document.parseResult.parserErrors.length > 0) {
         this.tracer.warn(`Parse errors in ${uri.toString()}; skipping descriptor.`);
         return undefined;
      }
      const root = document.parseResult.value;
      if (!isDomainModel(root) || !root.project) {
         // A `.domain` file without a `project` header is an ordinary member
         // of whatever folder-project encloses it, not a descriptor.
         return undefined;
      }
      const manifest = root.project;
      return {
         id: manifest.name,
         referenceName: UNQUALIFIED_PROJECT_REFERENCE,
         dependencies: manifest.dependencies.length > 0 ? [...manifest.dependencies] : undefined
      };
   }
}
