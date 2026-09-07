/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The multi-grammar composition contract: THREE languages over one shared tier,
 * from one `langium-cli` run, with per-language service overrides — and a
 * two-hop reference chain (`.layout` -> `.process` -> `.domain`) that only
 * resolves because they share an index.
 *
 * These are the assertions `bootstrapLangiumLanguages` and
 * `assertReflectionCoversLanguages` exist to enforce and that a stub language
 * cannot prove — a stub has no real grammar, parser or reflection.
 */

import { describe, expect, it } from 'vitest';
import { DomainSerializer } from '../src/language-server/domain-serializer.js';
import { OrderFlowLayoutScopeProvider } from '../src/language-server/layout-scope-provider.js';
import { LayoutSerializer } from '../src/language-server/layout-serializer.js';
import { ORDER_FLOW_CONFIGURATION_ROOT } from '../src/language-server/order-flow-module.js';
import { OrderFlowProcessScopeProvider } from '../src/language-server/process-scope-provider.js';
import { ProcessSerializer } from '../src/language-server/process-serializer.js';
import { makeServices, workspaceUri } from './order-flow-harness.js';

describe('order-flow composition — three grammars, one shared tier', () => {
   it('registers all three languages with distinct ids and file extensions', () => {
      const { shared } = makeServices();

      const registered = shared.ServiceRegistry.all.map(language => language.LanguageMetaData);
      expect(registered.map(metadata => metadata.languageId).sort()).toEqual([
         'order-flow-domain',
         'order-flow-layout',
         'order-flow-process'
      ]);
      expect(registered.flatMap(metadata => [...metadata.fileExtensions]).sort()).toEqual(['.domain', '.layout', '.process']);
   });

   it('routes each file extension to its own language services', () => {
      const { shared, domain, process: processServices, layout } = makeServices();

      expect(shared.ServiceRegistry.getServices(workspaceUri('orders/orders.domain'))).toBe(domain);
      expect(shared.ServiceRegistry.getServices(workspaceUri('orders/fulfillment.process'))).toBe(processServices);
      expect(shared.ServiceRegistry.getServices(workspaceUri('orders/fulfillment.layout'))).toBe(layout);
   });

   it('gives every language the SAME shared tier, which is what lets references cross grammars', () => {
      const { shared, domain, process: processServices, layout } = makeServices();

      expect(domain.shared).toBe(shared);
      expect(processServices.shared).toBe(shared);
      expect(layout.shared).toBe(shared);
      // The two-hop chain `.layout` -> `.process` -> `.domain` only resolves
      // because all three read one index and one project manager.
      expect(domain.shared.workspace.IndexManager).toBe(processServices.shared.workspace.IndexManager);
      expect(layout.shared.workspace.IndexManager).toBe(processServices.shared.workspace.IndexManager);
      expect(domain.shared.workspace.ProjectManager).toBe(processServices.shared.workspace.ProjectManager);
   });

   it('binds ONE AstReflection that knows the types of both grammars', () => {
      const { shared } = makeServices();

      // The single-`langium-config.json` constraint made observable: a
      // separately generated pair would leave one of these two unknown, and
      // `isSubtype` would answer false across the grammar boundary.
      const types = shared.AstReflection.getAllTypes();
      expect(types).toContain('Entity');
      expect(types).toContain('Write');
      expect(shared.AstReflection.isSubtype('Entity', 'Declaration')).toBe(true);
      expect(shared.AstReflection.isSubtype('Write', 'Effect')).toBe(true);
   });

   it('gives each language its own grammar-shaped serializer', () => {
      const { domain, process: processServices, layout } = makeServices();

      expect(domain.serializer.Serializer).toBeInstanceOf(DomainSerializer);
      expect(processServices.serializer.Serializer).toBeInstanceOf(ProcessSerializer);
      expect(layout.serializer.Serializer).toBeInstanceOf(LayoutSerializer);
   });

   it('overrides the scope provider per language, leaving .domain on the framework default', () => {
      const { domain, process: processServices, layout } = makeServices();

      // Each dependent-reference grammar gets its OWN provider: applying the
      // process one to `.layout` would leave `DiagramNode.flowNode` on the
      // global index, which resolves to any same-named node in the workspace.
      expect(processServices.references.ScopeProvider).toBeInstanceOf(OrderFlowProcessScopeProvider);
      expect(layout.references.ScopeProvider).toBeInstanceOf(OrderFlowLayoutScopeProvider);
      expect(layout.references.ScopeProvider).not.toBeInstanceOf(OrderFlowProcessScopeProvider);
      expect(domain.references.ScopeProvider).not.toBeInstanceOf(OrderFlowProcessScopeProvider);
      expect(domain.references.ScopeProvider).not.toBeInstanceOf(OrderFlowLayoutScopeProvider);
   });

   it('binds lsp.configurationRoot explicitly rather than inheriting registration order', () => {
      const { shared } = makeServices();

      // The framework default is the FIRST registered language id, which with
      // three grammars is an accident of ordering rather than a decision.
      expect(shared.lsp.configurationRoot).toBe(ORDER_FLOW_CONFIGURATION_ROOT);
      expect(shared.ServiceRegistry.all.map(language => language.LanguageMetaData.languageId)).not.toContain(shared.lsp.configurationRoot);
   });
});
