/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The container a synthetic source resolves to, against three real grammars.
 *
 * A create-element flow queries a scope BEFORE the file exists, so it asks at
 * the FOLDER the file is about to be written into. That URI names no file, so
 * it carries no extension and routes to no grammar — the one shape a stand-in
 * document cannot derive its language from, and the reason the framework takes
 * it from the provider instead.
 *
 * **The example binds nothing for this**, which is the claim: the framework
 * default materialises the container, so an adopter writes no
 * `resolveSyntheticSource` override to make a create dialog work.
 *
 * Stubbing the candidate provider hides all of it — the defect this guards
 * lives in materialising the container, which a stub never does. So these go
 * through the providers a booted server actually wires.
 */

import { type AstNode, URI } from '@hydranium/langium';
import { ReferenceSource } from '@hydranium/protocol';
import { describe, expect, it } from 'vitest';
import { makeServices } from './order-flow-harness.js';

/** The folder a `.process` file is about to be created in — no file, no extension. */
const FOLDER = 'file:///workspace/orders/processes';

/** The DI-bound provider for a language, reached the way a request reaches it. */
function scopeProviderOf(services: { references: { ScopeProvider: unknown } }): {
   resolveSyntheticSource(source: ReturnType<typeof ReferenceSource.synthetic>): AstNode | undefined;
} {
   // `resolveSyntheticSource` is protected — a test asserting the framework
   // DEFAULT has to reach it, and the alternative (a local subclass) would be
   // testing the subclass rather than what the example is wired with.
   return services.references.ScopeProvider as never;
}

describe('a scope query at the folder a file is about to be created in', () => {
   it('materialises a container under the querying grammar, not the URI extension', () => {
      const services = makeServices();

      const container = scopeProviderOf(services.process).resolveSyntheticSource(ReferenceSource.synthetic(FOLDER, 'Transition'));

      // The stand-in's root is the PROCESS entry type: the provider is bound
      // per grammar, and its own language is the only routing signal a folder
      // URI leaves. Deriving it from the URI is what fails here.
      expect(container?.$type).toBe('Transition');
      expect(container?.$container?.$type).toBe('ProcessModel');
   });

   it('serves each grammar its own entry type from the same folder URI', () => {
      const services = makeServices();

      // Same URI, two grammars: nothing about the URI decides this, which is
      // what a single-grammar example could not show.
      const fromProcess = scopeProviderOf(services.process).resolveSyntheticSource(ReferenceSource.synthetic(FOLDER, 'Transition'));
      const fromDomain = scopeProviderOf(services.domain).resolveSyntheticSource(ReferenceSource.synthetic(FOLDER, 'Entity'));

      expect(fromProcess?.$container?.$type).toBe('ProcessModel');
      expect(fromDomain?.$container?.$type).toBe('DomainModel');
   });

   it('leaves the stand-in unregistered, so it cannot mask the file once written', () => {
      const services = makeServices();

      scopeProviderOf(services.process).resolveSyntheticSource(ReferenceSource.synthetic(FOLDER, 'Transition'));

      expect(services.shared.workspace.LangiumDocuments.hasDocument(URI.parse(FOLDER))).toBe(false);
   });
});
