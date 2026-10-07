/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { Container } from 'inversify';
import type { ServerLanguageServices, ServerSharedServices } from '@hydranium/core';
import type { LanguageMetaData } from '@hydranium/langium';
import { makeNoopSharedServices, makeStubServiceRegistry, type StubServiceRegistry } from '@hydranium/core/testing';
import {
   type ActionDispatcher,
   ActionHandlerConstructor,
   type BindingTarget,
   InstanceMultiBinding,
   SaveModelActionHandler
} from '@eclipse-glsp/server';
import { HydraniumGlspServerActionDispatcher } from '../src/dispatcher/server-action-dispatcher.js';
import { AbstractHydraniumGlspDiagramModule, bindDiagramLanguage } from '../src/launcher/abstract-hydranium-glsp-diagram-module.js';
import { HydraniumGlspRequestSaveModelActionHandler } from '../src/storage/hydranium-glsp-request-save-model-action-handler.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';

/** Shaped like a generated `<Grammar>LanguageMetaData` constant. */
function metadata(languageId: string, fileExtensions: string[]): LanguageMetaData {
   return { languageId, fileExtensions, caseInsensitive: false, mode: 'development' };
}

const LANG_A = metadata('langA', ['.a']);
const LANG_B = metadata('langB', ['.b']);

/** A session container plus the registry its language factory resolves through. */
interface SessionFixture {
   readonly container: Container;
   /**
    * The registry `resolveDiagramLanguage` calls. Exposed so a test can count
    * factory invocations: the registry answers from its own map, so object
    * identity across two injections is no evidence about the binding scope.
    */
   readonly registry: StubServiceRegistry;
}

/**
 * An app-tier container carrying the shared services, with the diagram-tier
 * language bindings applied to a child container — mirroring GLSP's
 * app -> server -> session hierarchy, where a `DiagramModule` loads into a
 * child of the container holding `SharedCoreServices`.
 */
function createSessionFixture(declared: LanguageMetaData): SessionFixture {
   const registry = makeStubServiceRegistry([
      {
         languageId: 'langA',
         fileExtensions: ['.a'],
         services: { references: { ScopeProvider: { tag: 'langA-scope' }, CandidateProvider: { tag: 'langA-candidates' } } }
      },
      {
         languageId: 'langB',
         fileExtensions: ['.b'],
         services: { references: { ScopeProvider: { tag: 'langB-scope' }, CandidateProvider: { tag: 'langB-candidates' } } }
      }
   ]);
   const appContainer = new Container();
   appContainer
      .bind(HydraniumTypes.SharedCoreServices)
      .toConstantValue(makeNoopSharedServices<ServerSharedServices>({ ServiceRegistry: registry }));
   const sessionContainer = appContainer.createChild();
   bindDiagramLanguage(sessionContainer.bind.bind(sessionContainer), declared);
   return { container: sessionContainer, registry };
}

function createSessionContainer(declared: LanguageMetaData): Container {
   return createSessionFixture(declared).container;
}

describe('bindDiagramLanguage', () => {
   it('binds the declared language services on the session tier', () => {
      const container = createSessionContainer(LANG_A);
      const language = container.get<ServerLanguageServices>(HydraniumTypes.DiagramLanguage);
      expect(language.LanguageMetaData.languageId).toBe('langA');
   });

   it('reaches the declared language providers through the bound language', () => {
      const container = createSessionContainer(LANG_B);
      const language = container.get<ServerLanguageServices>(HydraniumTypes.DiagramLanguage);
      expect(language.references.ScopeProvider).toMatchObject({ tag: 'langB-scope' });
      expect(language.references.CandidateProvider).toMatchObject({ tag: 'langB-candidates' });
   });

   it('gives two diagram types their own language, not a shared process-wide one', () => {
      const langA = createSessionContainer(LANG_A);
      const langB = createSessionContainer(LANG_B);
      expect(langA.get<ServerLanguageServices>(HydraniumTypes.DiagramLanguage).references.ScopeProvider).toMatchObject({
         tag: 'langA-scope'
      });
      expect(langB.get<ServerLanguageServices>(HydraniumTypes.DiagramLanguage).references.ScopeProvider).toMatchObject({
         tag: 'langB-scope'
      });
   });

   it('fails with a message naming the declared and registered ids when the language is not registered', () => {
      const container = createSessionContainer(metadata('absent', ['.nope']));
      expect(() => container.get(HydraniumTypes.DiagramLanguage)).toThrow(/'absent'.*langA.*langB/s);
   });

   it('resolves the language once per session rather than per injection', () => {
      const { container, registry } = createSessionFixture(LANG_A);
      const resolutions = vi.spyOn(registry, 'getServices');
      const first = container.get(HydraniumTypes.DiagramLanguage);
      const second = container.get(HydraniumTypes.DiagramLanguage);
      expect(first).toBe(second);
      // Identity is no witness for the scope: the registry answers both
      // injections from its own map, so a per-injection factory would return
      // the same object too. Only the factory's invocation count can see it.
      expect(resolutions).toHaveBeenCalledTimes(1);
   });
});

/** Exposes what the base registers; the bindings it never reaches throw. */
class ProbeModule extends AbstractHydraniumGlspDiagramModule {
   readonly diagramType = 'probe';

   protected declareLanguage(): LanguageMetaData {
      return LANG_A;
   }
   protected bindSourceModelStorage(): never {
      throw new Error('not reached');
   }
   protected bindModelState(): never {
      throw new Error('not reached');
   }
   protected bindDiagramConfiguration(): never {
      throw new Error('not reached');
   }
   protected bindGModelFactory(): never {
      throw new Error('not reached');
   }

   registeredActionHandlers(): ActionHandlerConstructor[] {
      const binding = new InstanceMultiBinding<ActionHandlerConstructor>(ActionHandlerConstructor);
      this.configureActionHandlers(binding);
      return binding.getAll();
   }

   boundActionDispatcher(): BindingTarget<ActionDispatcher> {
      return this.bindActionDispatcher();
   }
}

describe('AbstractHydraniumGlspDiagramModule action handlers', () => {
   it('answers the Theia client’s save request and keeps GLSP’s save for other clients', () => {
      const handlers = new ProbeModule().registeredActionHandlers();

      expect(handlers).toContain(HydraniumGlspRequestSaveModelActionHandler);
      expect(handlers).toContain(SaveModelActionHandler);
   });
});

describe('AbstractHydraniumGlspDiagramModule action dispatcher', () => {
   it('times every dispatch through HydraniumGlspServerActionDispatcher', () => {
      expect(new ProbeModule().boundActionDispatcher()).toBe(HydraniumGlspServerActionDispatcher);
   });
});
