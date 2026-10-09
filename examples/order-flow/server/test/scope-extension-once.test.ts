/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A scope extension runs once for each scope the provider builds, and both of
 * its tiers still resolve.
 *
 * The extension's work is counted rather than timed, so a second run per
 * reference fails here as a number instead of hiding in a slower build.
 */

import { type ScopeExtensionContribution, type ScopeExtensionRegistry } from '@hydranium/core';
import { makeCapturingTracer } from '@hydranium/core/testing';
import { type ReferenceInfo, URI } from '@hydranium/langium';
import { Logger } from '@hydranium/protocol';
import { describe, expect, it } from 'vitest';
import type { ProcessModel } from '../src/language-server/ast.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness } from './order-flow-harness.js';

const LOCAL_NAME = 'probeLocal';
const UNIVERSAL_NAME = 'probeUniversal';

class CountingScopeContribution implements ScopeExtensionContribution {
   calls = 0;

   registerScopeExtensions(registry: ScopeExtensionRegistry): void {
      registry.register({
         id: 'test:counting',
         referenceTypes: ['Entity'],
         addDescriptions: (context, _referenceType, document, accept) => {
            this.calls++;
            accept.local({ node: context, name: LOCAL_NAME, document });
            accept.universal({ node: context, name: UNIVERSAL_NAME, document });
         }
      });
   }
}

describe('order-flow scope extensions', () => {
   it('runs an extension once per scope and resolves both of its tiers', async () => {
      const contribution = new CountingScopeContribution();
      const { harness, workspace } = await makeScratchWorkspaceHarness(undefined, {
         extraLanguageModules: [{ references: { scopes: { counting: () => contribution } } }]
      });
      try {
         const returnsUri = URI.file(workspace.resolve(WORKSPACE_FILES.returnsProcess));
         const returnsDocument = harness.shared.workspace.LangiumDocuments.getDocument(returnsUri);
         if (!returnsDocument) {
            throw new Error(`Document not loaded: ${WORKSPACE_FILES.returnsProcess}`);
         }
         const returns = returnsDocument.parseResult.value as ProcessModel;
         const referenceInfo: ReferenceInfo = { reference: returns.subject, container: returns, property: 'subject' };

         contribution.calls = 0;
         const scope = harness.process.references.ScopeProvider.getScope(referenceInfo);

         expect(contribution.calls).toBe(1);
         expect(scope.getElement(LOCAL_NAME)).toBeDefined();
         expect(scope.getElement(UNIVERSAL_NAME)).toBeDefined();
      } finally {
         workspace.dispose();
      }
   });
});

describe('order-flow scope extension profile', () => {
   it('reports the extensions of the workspace build, which validates nothing', async () => {
      const level = Logger.getLevel();
      const { tracer, lines } = makeCapturingTracer();
      const contribution = new CountingScopeContribution();
      Logger.setLevel('debug');
      try {
         const { workspace } = await makeScratchWorkspaceHarness(undefined, {
            extraSharedModules: [{ Tracer: () => tracer }],
            extraLanguageModules: [{ references: { scopes: { counting: () => contribution } } }]
         });
         workspace.dispose();
      } finally {
         Logger.setLevel(level);
      }

      // The build has to have run the extension for a missing report to mean anything.
      expect(contribution.calls).toBeGreaterThan(0);
      // The extension resolves process subjects, so the process language reports it.
      const reports = lines.map(line => line.message).filter(message => message.includes('[profile scope-extension order-flow-process]'));
      expect(reports.some(message => message.includes('test:counting'))).toBe(true);
   });
});
