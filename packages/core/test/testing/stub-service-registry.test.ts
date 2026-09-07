/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { URI } from '@hydranium/langium';
import { buildLanguageTypeIndex } from '../../src/langium/language-types.js';
import { makeStubServiceRegistry, makeTestServices, type StubLanguageDescriptor } from '../../src/testing/index.js';

const FAKE: StubLanguageDescriptor = { languageId: 'fake', fileExtensions: ['.fake'], producedTypes: ['TypeOne', 'TypeTwo'] };
const OTHER: StubLanguageDescriptor = { languageId: 'other', fileExtensions: ['.other'], producedTypes: ['BaseType'] };

describe('makeStubServiceRegistry', () => {
   describe('routing — Langium ladder', () => {
      it('routes by file extension', () => {
         const registry = makeStubServiceRegistry([FAKE, OTHER]);
         expect(registry.getServices(URI.parse('file:///a.fake')).LanguageMetaData.languageId).toBe('fake');
         expect(registry.getServices(URI.parse('file:///a.other')).LanguageMetaData.languageId).toBe('other');
      });

      it('routes by whole file name ahead of the extension', () => {
         const registry = makeStubServiceRegistry([
            FAKE,
            { languageId: 'manifest', fileExtensions: ['.manifest'], fileNames: ['project.fake'] }
         ]);
         // `project.fake` matches BOTH rungs; Langium consults fileNameMap first.
         expect(registry.getServices(URI.parse('file:///project.fake')).LanguageMetaData.languageId).toBe('manifest');
         expect(registry.getServices(URI.parse('file:///other.fake')).LanguageMetaData.languageId).toBe('fake');
      });

      it("routes by an open document's declared languageId ahead of its extension", () => {
         const registry = makeStubServiceRegistry([FAKE, OTHER], { openLanguageIds: { 'file:///a.fake': 'other' } });
         expect(registry.getServices(URI.parse('file:///a.fake')).LanguageMetaData.languageId).toBe('other');
      });

      it('falls through to the extension when the declared languageId is not registered', () => {
         const registry = makeStubServiceRegistry([FAKE, OTHER], { openLanguageIds: { 'file:///a.fake': 'stale-id' } });
         expect(registry.getServices(URI.parse('file:///a.fake')).LanguageMetaData.languageId).toBe('fake');
      });

      it('resolves an extensionless URI by its declared languageId alone', () => {
         // The untitled/extensionless case: no extension rung can answer, so the
         // declared id is the only signal.
         const registry = makeStubServiceRegistry([FAKE, OTHER], { openLanguageIds: { 'untitled:Untitled-1': 'other' } });
         expect(registry.getServices(URI.parse('untitled:Untitled-1')).LanguageMetaData.languageId).toBe('other');
      });

      it('seedOpen / seedClosed drive the languageId rung after construction', () => {
         const registry = makeStubServiceRegistry([FAKE, OTHER]);
         registry.seedOpen('file:///a.fake', 'other');
         expect(registry.getServices(URI.parse('file:///a.fake')).LanguageMetaData.languageId).toBe('other');
         registry.seedClosed('file:///a.fake');
         expect(registry.getServices(URI.parse('file:///a.fake')).LanguageMetaData.languageId).toBe('fake');
      });
   });

   describe('misses', () => {
      it("throws Langium's own message for an unroutable URI", () => {
         const registry = makeStubServiceRegistry([FAKE]);
         expect(() => registry.getServices(URI.parse('file:///workspace/Element'))).toThrow(/no services for the extension/);
      });

      it('does not fall back to the sole registered language for an unroutable URI', () => {
         // Langium's ServiceRegistry INTERFACE doc claims a single registered
         // language may serve any URI; the 4.3.1 implementation has no such
         // fallback. Pinned because callers — the data-server's reference-source
         // router among them — are built around the throw, not around a fallback.
         const registry = makeStubServiceRegistry([FAKE]);
         expect(registry.hasServices(URI.parse('file:///workspace/Element'))).toBe(false);
      });

      it('hasServices probes without throwing', () => {
         const registry = makeStubServiceRegistry([FAKE, OTHER]);
         expect(registry.hasServices(URI.parse('file:///a.other'))).toBe(true);
         expect(registry.hasServices(URI.parse('file:///a.unknown'))).toBe(false);
      });
   });

   describe('extended lookup paths', () => {
      it('exposes getServicesById and getServicesByExtension', () => {
         const registry = makeStubServiceRegistry([FAKE, OTHER]);
         expect(registry.getServicesById('other')?.LanguageMetaData.languageId).toBe('other');
         expect(registry.getServicesById('nope')).toBeUndefined();
         expect(registry.getServicesByExtension('.fake')?.LanguageMetaData.languageId).toBe('fake');
      });

      it('reports every registered language on `all`, in registration order', () => {
         const registry = makeStubServiceRegistry([FAKE, OTHER]);
         expect(registry.all.map(language => language.LanguageMetaData.languageId)).toEqual(['fake', 'other']);
         expect([...registry.languagesById.keys()]).toEqual(['fake', 'other']);
      });
   });

   describe('synthesised grammars', () => {
      it('feed type→language routing through the real index builder', () => {
         const registry = makeStubServiceRegistry([FAKE, OTHER]);
         const index = buildLanguageTypeIndex(registry.all);
         expect(index.languagesFor('BaseType').map(language => language.LanguageMetaData.languageId)).toEqual(['other']);
         expect(index.typesOf('fake')).toEqual(new Set(['TypeOne', 'TypeTwo']));
      });

      it('report a shared type as owned by BOTH languages', () => {
         // Two grammars importing a common base both produce its types; the
         // index reports several owners, which is the caller's signal that the
         // type alone does not identify a language.
         const registry = makeStubServiceRegistry([
            { ...FAKE, producedTypes: ['TypeOne', 'SharedType'] },
            { ...OTHER, producedTypes: ['BaseType', 'SharedType'] }
         ]);
         const owners = buildLanguageTypeIndex(registry.all).languagesFor('SharedType');
         expect(owners.map(language => language.LanguageMetaData.languageId)).toEqual(['fake', 'other']);
      });
   });

   describe('per-language service slots', () => {
      it('carries caller-supplied slots and no-op defaults for the rest', () => {
         const marker = { find: () => [] };
         const registry = makeStubServiceRegistry([{ ...FAKE, services: { references: { CandidateProvider: marker } } }]);
         const language = registry.getServices(URI.parse('file:///a.fake'));
         expect(language.references.CandidateProvider).toBe(marker);
         expect(language.shared).toBeDefined();
      });
   });
});

describe('makeTestServices — languages option', () => {
   it('binds the stub registry on the ServiceRegistry slot', () => {
      const bundle = makeTestServices({ languages: [FAKE, OTHER] });
      expect(bundle.serviceRegistry).toBeDefined();
      expect(bundle.services.ServiceRegistry.getServices(URI.parse('file:///a.other')).LanguageMetaData.languageId).toBe('other');
   });

   it('forwards openLanguageIds to the registry', () => {
      const bundle = makeTestServices({ languages: [FAKE, OTHER], openLanguageIds: { 'file:///a.fake': 'other' } });
      expect(bundle.services.ServiceRegistry.getServices(URI.parse('file:///a.fake')).LanguageMetaData.languageId).toBe('other');
   });

   it('leaves the slot ABSENT when no languages are declared', () => {
      // Deliberate: production paths that optional-chain `ServiceRegistry`
      // (ModelService.rewriteModel) must keep seeing it missing, so the
      // default bundle's behaviour is unchanged by this option existing.
      const bundle = makeTestServices();
      expect(bundle.serviceRegistry).toBeUndefined();
      expect('ServiceRegistry' in bundle.services).toBe(false);
   });
});
