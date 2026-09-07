/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNodeDescription, URI } from '@hydranium/langium';

/**
 * Options for {@link makeFakeDescription}. Extends `Partial<AstNodeDescription>`
 * (override any standard field) plus the tier-index extras (`tier`, `projectId`)
 * that live on a `TieredAstNodeDescription` — attached without the caller
 * writing an `as unknown as` cast.
 */
export interface FakeDescriptionOptions extends Partial<AstNodeDescription> {
   /** Visibility tier (`'local' | 'project' | 'public' | 'universal'`) to stamp on the description. */
   tier?: string;
   /** Owning project id, for project/public-tier descriptions. */
   projectId?: string;
}

/**
 * Build an {@link AstNodeDescription} fixture for scope / candidate / tier tests.
 *
 * Defaults model distinct nodes: `type: 'Fake'`, `documentUri: memory://test`,
 * and a per-name `path` (`'/' + name`) so distinct names key as distinct nodes
 * under the canonical filter (which keys on `documentUri#path`). Tier-sibling
 * cases that model ONE node under several names pass an explicit shared `path`.
 * `tier` / `projectId` are stamped on when provided; the cast that needs (those
 * fields live on `TieredAstNodeDescription`, not on `AstNodeDescription`) is
 * encapsulated here so call sites stay cast-free. The description sibling of
 * `makeFakeAstNode`.
 */
export function makeFakeDescription(name: string, opts: FakeDescriptionOptions = {}): AstNodeDescription {
   const description: AstNodeDescription = {
      name,
      type: opts.type ?? 'Fake',
      documentUri: opts.documentUri ?? URI.parse('memory://test'),
      path: opts.path ?? '/' + name,
      node: opts.node
   };
   if (opts.tier !== undefined) {
      (description as unknown as Record<string, string>).tier = opts.tier;
   }
   if (opts.projectId !== undefined) {
      (description as unknown as Record<string, string>).projectId = opts.projectId;
   }
   return description;
}
