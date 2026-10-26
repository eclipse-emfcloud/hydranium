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
import { AstUtils, DocumentState, type ReferenceInfo, URI } from '@hydranium/langium';
import { Logger } from '@hydranium/protocol';
import { describe, expect, it } from 'vitest';
import { type ProcessModel, isProcessModel } from '../src/language-server/ast.js';
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

const NODE_NAME = 'probeNode';

/** Answers a description per process, keyed on the process. */
class KeyedScopeContribution implements ScopeExtensionContribution {
   calls = 0;

   registerScopeExtensions(registry: ScopeExtensionRegistry): void {
      registry.register({
         id: 'test:keyed',
         referenceTypes: ['FlowNode'],
         cacheKey: context => AstUtils.getContainerOfType(context, isProcessModel),
         addDescriptions: (context, _referenceType, document, accept) => {
            this.calls++;
            accept.local({ node: context, name: NODE_NAME, document });
         }
      });
   }
}

describe('order-flow keyed scope extensions', () => {
   it('runs a keyed extension afresh and once while a process is relinked, and per lookup after', async () => {
      const contribution = new KeyedScopeContribution();
      const { harness, workspace } = await makeScratchWorkspaceHarness(undefined, {
         extraLanguageModules: [{ references: { scopes: { keyed: () => contribution } } }]
      });
      try {
         const returnsUri = URI.file(workspace.resolve(WORKSPACE_FILES.returnsProcess));
         const returnsDocument = harness.shared.workspace.LangiumDocuments.getDocument(returnsUri);
         const returns = returnsDocument?.parseResult.value as ProcessModel | undefined;
         const transition = returns?.transitions[0];
         if (!returnsDocument || !returns || !transition) {
            throw new Error(`No transition in ${WORKSPACE_FILES.returnsProcess}`);
         }
         const scopeOf = (property: 'source' | 'target') =>
            harness.process.references.ScopeProvider.getScope({ reference: transition[property], container: transition, property });

         // Lookups after the link, as a completion request makes, and one after the relink's build
         // starts; the relink must reuse none of them.
         contribution.calls = 0;
         const scopes = [scopeOf('source'), scopeOf('target')];
         const afterLink = contribution.calls;
         const builder = harness.shared.workspace.DocumentBuilder;
         builder.resetToState(returnsDocument, DocumentState.ComputedScopes);
         const lookupWhileBuilding = builder.onUpdate(() => {
            scopeOf('source');
            contribution.calls = 0;
         });
         try {
            await builder.build([returnsDocument]);
         } finally {
            lookupWhileBuilding.dispose();
         }

         expect({ afterLink, relink: contribution.calls }).toEqual({ afterLink: 2, relink: 1 });
         expect(scopes.map(scope => scope.getElement(NODE_NAME) !== undefined)).toEqual([true, true]);
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
