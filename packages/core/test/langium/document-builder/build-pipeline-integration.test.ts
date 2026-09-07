/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { Disposable } from '@hydranium/protocol';
import { DocumentState, URI, type LangiumDocument } from '@hydranium/langium';
import { CancellationToken } from 'vscode-languageserver';
import type { ServerSharedServices } from '../../../src/langium/module.js';
import { BuildPipelineIntegration } from '../../../src/langium/document-builder/build-pipeline-integration.js';
import { DefaultBuildPhasePassService } from '../../../src/langium/build-phase-pass/build-phase-pass-service.js';
import { makeNoopSharedServices, makeStubServiceRegistry, type NoopLanguageServicesOverrides } from '../../../src/testing/index.js';

/** Real registry — integrity dispatches through it, so the routing tests exercise the true path. */
function buildPhasePassService(): DefaultBuildPhasePassService {
   return new DefaultBuildPhasePassService(makeNoopSharedServices<ServerSharedServices>());
}

type BuildListener = (documents: readonly LangiumDocument[], cancelToken: CancellationToken) => unknown;
type DocumentListener = (document: LangiumDocument, cancelToken: CancellationToken) => unknown;

/** Captures the phase listeners the integration attaches so tests can fire them. */
class FakeDocumentBuilder {
   readonly buildListeners = new Map<DocumentState, BuildListener[]>();
   readonly documentListeners = new Map<DocumentState, DocumentListener[]>();

   onBuildPhase(state: DocumentState, listener: BuildListener): { dispose: () => void } {
      const list = this.buildListeners.get(state) ?? [];
      list.push(listener);
      this.buildListeners.set(state, list);
      return Disposable.EMPTY;
   }

   onDocumentPhase(state: DocumentState, listener: DocumentListener): { dispose: () => void } {
      const list = this.documentListeners.get(state) ?? [];
      list.push(listener);
      this.documentListeners.set(state, list);
      return Disposable.EMPTY;
   }

   fireBuild(state: DocumentState, documents: readonly LangiumDocument[]): Promise<unknown[]> {
      return Promise.all((this.buildListeners.get(state) ?? []).map(listener => listener(documents, CancellationToken.None)));
   }

   fireDocument(state: DocumentState, document: LangiumDocument): void {
      this.documentListeners.get(state)?.forEach(listener => listener(document, CancellationToken.None));
   }

   buildCount(state: DocumentState): number {
      return this.buildListeners.get(state)?.length ?? 0;
   }

   documentCount(state: DocumentState): number {
      return this.documentListeners.get(state)?.length ?? 0;
   }
}

function setup(): {
   builder: FakeDocumentBuilder;
   integrityCalls: Array<{ documents: readonly LangiumDocument[]; phase: DocumentState }>;
   astCalls: Array<{ document: LangiumDocument; phase: DocumentState }>;
   collectorTouches: number;
} {
   const builder = new FakeDocumentBuilder();
   const integrityCalls: Array<{ documents: readonly LangiumDocument[]; phase: DocumentState }> = [];
   const astCalls: Array<{ document: LangiumDocument; phase: DocumentState }> = [];
   let collectorTouches = 0;
   // Per-language integrity is resolved through the ServiceRegistry; a single
   // language stub means every document groups under one IntegrityService.
   const integrityService = {
      enforceBatch: (documents: readonly LangiumDocument[], phase: DocumentState) => {
         integrityCalls.push({ documents, phase });
         return Promise.resolve();
      }
   };
   const astExtensionService = {
      extendDocument: (document: LangiumDocument, phase: DocumentState) => void astCalls.push({ document, phase })
   };
   // The per-language validation slot exposes the contribution collector as
   // a getter so the test can count how often the orchestrator touches it.
   const validationSlot = {
      get ValidationContributionCollector() {
         collectorTouches++;
         return {/* collector instance — opaque to the test */};
      }
   };
   const languageServices = {
      integrity: { IntegrityService: integrityService },
      ast: { AstExtensionService: astExtensionService },
      validation: validationSlot
   };
   const services = makeNoopSharedServices<ServerSharedServices>({
      workspace: { DocumentBuilder: builder, BuildPhasePassService: buildPhasePassService() },
      // Degenerate single-language registry: every URI routes to the one
      // language, so `hasServices` is unconditionally true. The multi-language
      // suite below uses a real `makeStubServiceRegistry` instead.
      ServiceRegistry: {
         hasServices: () => true,
         getServices: () => languageServices
      }
   });
   new BuildPipelineIntegration(services);
   return {
      builder,
      integrityCalls,
      astCalls,
      get collectorTouches() {
         return collectorTouches;
      }
   } as ReturnType<typeof setup>;
}

const AST_PHASES: readonly DocumentState[] = [
   DocumentState.Parsed,
   DocumentState.ComputedScopes,
   DocumentState.Linked,
   DocumentState.IndexedReferences,
   DocumentState.Validated
];

// A real `URI`, not a `{ toString }` shell: the multi-language suite routes
// these through a real `ServiceRegistry`, which parses the extension off the
// URI rather than reading its string form.
const doc = (name: string): LangiumDocument => ({ uri: URI.parse(`file:///${name}`) }) as unknown as LangiumDocument;

describe('BuildPipelineIntegration — listener wiring', () => {
   it('attaches a build-phase pass dispatcher on every useful build phase', () => {
      const { builder } = setup();
      // Integrity is a registered pass dispatched via BuildPhasePassService, so
      // a single dispatcher listener is wired per useful build phase (not just
      // Parsed/Linked — passes can target any of them).
      for (const phase of AST_PHASES) {
         expect(builder.buildCount(phase)).toBe(1);
      }
   });

   it('attaches AST enrichment on every useful document phase', () => {
      const { builder } = setup();
      for (const phase of AST_PHASES) {
         expect(builder.documentCount(phase)).toBe(1);
      }
   });

   it('does not attach listeners for non-useful phases', () => {
      const { builder } = setup();
      expect(builder.buildCount(DocumentState.Changed)).toBe(0);
      expect(builder.buildCount(DocumentState.IndexedContent)).toBe(0);
      expect(builder.documentCount(DocumentState.Changed)).toBe(0);
      expect(builder.documentCount(DocumentState.IndexedContent)).toBe(0);
   });
});

describe('BuildPipelineIntegration — routing', () => {
   it('routes the Parsed build phase to integrity.enforceBatch', () => {
      const { builder, integrityCalls } = setup();
      const documents = [doc('a'), doc('b')];
      builder.fireBuild(DocumentState.Parsed, documents);
      expect(integrityCalls).toEqual([{ documents, phase: DocumentState.Parsed }]);
   });

   it('routes the Linked build phase to integrity.enforceBatch', () => {
      const { builder, integrityCalls } = setup();
      const documents = [doc('a')];
      builder.fireBuild(DocumentState.Linked, documents);
      expect(integrityCalls).toEqual([{ documents, phase: DocumentState.Linked }]);
   });

   it.each(AST_PHASES)('routes the %s document phase to ast.extendDocument', phase => {
      const { builder, astCalls } = setup();
      const document = doc('a');
      builder.fireDocument(phase, document);
      expect(astCalls).toEqual([{ document, phase }]);
   });

   it('touches ValidationContributionCollector once per language in the batch', () => {
      const result = setup();
      expect(result.collectorTouches).toBe(0);
      result.builder.fireBuild(DocumentState.Parsed, [doc('a'), doc('b')]);
      // Both documents resolve to the same language, so the slot is forced
      // once for the batch rather than once per document. What matters is that
      // every language present gets its collector constructed before its
      // integrity pass runs; repeating that per document only leaned on
      // Langium's DI proxy to cache the redundant reads.
      expect(result.collectorTouches).toBe(1);
   });
});

type IntegrityCalls = Array<{ documents: readonly LangiumDocument[]; phase: DocumentState }>;

/**
 * Two-language registry: `.b` documents resolve to language B, `.a` documents
 * to language A. Each language owns its own IntegrityService recorder plus the
 * ast + validation slots the constructor and routing helper touch.
 *
 * Routing goes through a real `ExtendedServiceRegistry`
 * ({@link makeStubServiceRegistry}), so the grouping under test is driven by
 * the same extension lookup a booted two-grammar server uses.
 */
function setupMultiLanguage(): { builder: FakeDocumentBuilder; integrityCallsA: IntegrityCalls; integrityCallsB: IntegrityCalls } {
   const builder = new FakeDocumentBuilder();
   const integrityCallsA: IntegrityCalls = [];
   const integrityCallsB: IntegrityCalls = [];
   const languageSlots = (calls: IntegrityCalls): NoopLanguageServicesOverrides => ({
      integrity: {
         IntegrityService: {
            enforceBatch: (documents: readonly LangiumDocument[], phase: DocumentState) => {
               calls.push({ documents, phase });
               return Promise.resolve();
            }
         }
      },
      ast: { AstExtensionService: { extendDocument: () => undefined } },
      validation: {
         get ValidationContributionCollector() {
            return {};
         }
      }
   });
   const services = makeNoopSharedServices<ServerSharedServices>({
      workspace: { DocumentBuilder: builder, BuildPhasePassService: buildPhasePassService() },
      ServiceRegistry: makeStubServiceRegistry([
         { languageId: 'a', fileExtensions: ['.a'], services: languageSlots(integrityCallsA) },
         { languageId: 'b', fileExtensions: ['.b'], services: languageSlots(integrityCallsB) }
      ])
   });
   new BuildPipelineIntegration(services);
   return { builder, integrityCallsA, integrityCallsB };
}

describe('BuildPipelineIntegration — multi-grammar routing', () => {
   it('groups a mixed-language Parsed batch by language and enforces each group once', async () => {
      const { builder, integrityCallsA, integrityCallsB } = setupMultiLanguage();
      const docA1 = doc('a1.a');
      const docB1 = doc('b1.b');
      const docA2 = doc('a2.a');
      // callIntegrity awaits each language's enforceBatch in turn, so flush the
      // microtask chain before asserting both groups landed.
      await builder.fireBuild(DocumentState.Parsed, [docA1, docB1, docA2]);
      // Each language's IntegrityService is called exactly once, with only its
      // own documents, in their original batch order.
      expect(integrityCallsA).toEqual([{ documents: [docA1, docA2], phase: DocumentState.Parsed }]);
      expect(integrityCallsB).toEqual([{ documents: [docB1], phase: DocumentState.Parsed }]);
   });
});

describe('BuildPipelineIntegration — foundational pass ordering', () => {
   it('runs the framework integrity pass before a default-priority adopter pass at the same state', async () => {
      const builder = new FakeDocumentBuilder();
      const order: string[] = [];
      const passes = buildPhasePassService();
      // Adopter pass registered BEFORE BuildPipelineIntegration, with NO explicit
      // priority (the natural default of 0). This mirrors the real registration
      // order: adopter passes register at BuildPhasePassService construction (via
      // the contribution group), the framework integrity pass registers later in
      // BuildPipelineIntegration's constructor. Integrity must still run first —
      // it cleans/mutates the AST that derived adopter passes read — so it sits in
      // a negative foundational band rather than tying with the adopter's default 0
      // (a tie would break by registration order, letting the adopter win).
      passes.register({ id: 'adopter', state: DocumentState.Linked, run: () => void order.push('adopter') });

      const integrityService = {
         enforceBatch: () => {
            order.push('integrity');
            return Promise.resolve();
         }
      };
      const languageServices = {
         integrity: { IntegrityService: integrityService },
         ast: { AstExtensionService: { extendDocument: () => undefined } },
         validation: {
            get ValidationContributionCollector() {
               return {};
            }
         }
      };
      const services = makeNoopSharedServices<ServerSharedServices>({
         workspace: { DocumentBuilder: builder, BuildPhasePassService: passes },
         ServiceRegistry: { hasServices: () => true, getServices: () => languageServices }
      });
      new BuildPipelineIntegration(services);

      await builder.fireBuild(DocumentState.Linked, [doc('a')]);
      expect(order).toEqual(['integrity', 'adopter']);
   });
});
