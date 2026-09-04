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
import type { AstNode, LangiumCoreServices } from '@hydranium/langium';
import type { LangiumServices } from '@hydranium/langium/lsp';
import { createServerLanguageModule, type HydraniumLanguageServices } from '../../src/langium/language-module.js';
import type { ServerModuleContext } from '../../src/langium/module.js';
import { DefaultElementKeyProvider } from '../../src/langium/keys/default-element-key-provider.js';
import { type ElementKeyProvider } from '../../src/langium/keys/element-key-provider.js';
import { DefaultNameProvider, type NameProvider } from '../../src/langium/naming/name-provider.js';
import type { Serializer } from '../../src/langium/serialization/serializer.js';
import { makeNoopTracer } from '../../src/testing/index.js';

/**
 * `createServerLanguageModule` is typed as `Module<I, T> | injectorFn`, whose
 * mapped slot values are factory-or-nested-module unions TS won't narrow to the
 * concrete leaf factories. The runtime object exposes these nested `(services)
 * => service` factories directly; this view recovers type-safe access without
 * changing the runtime read.
 */
interface LanguageModuleView {
   readonly serializer: { readonly Serializer: (services: LangiumServices) => Serializer };
   readonly references: {
      readonly NameProvider: (services: LangiumCoreServices) => NameProvider;
      readonly ElementKeyProvider: (services: LangiumCoreServices) => ElementKeyProvider;
   };
}

function moduleView(context: ServerModuleContext): LanguageModuleView {
   return createServerLanguageModule(context) as unknown as LanguageModuleView;
}

const emptyContext = {} as ServerModuleContext;
const emptyServices = {} as LangiumServices;

const noopLogger: { for: () => typeof noopLogger; trace: () => void } = {
   for: () => noopLogger,
   trace: () => undefined
};

/** Services stub for the ElementKeyProvider factory, which reads `references.NameProvider` in its constructor. */
function servicesWithNameProvider(): LangiumCoreServices {
   const sharedStub = {
      shared: {
         workspace: {
            ProjectManager: { getProject: () => undefined },
            DocumentBuilder: { onUpdate: () => Disposable.EMPTY }
         },
         Logger: noopLogger,
         Tracer: makeNoopTracer()
      }
   } as unknown as HydraniumLanguageServices;
   const nameProvider = new DefaultNameProvider(sharedStub);
   return {
      ...sharedStub,
      references: { NameProvider: nameProvider }
   } as unknown as LangiumCoreServices;
}

describe('createServerLanguageModule', () => {
   describe('serializer.Serializer default (UnboundSerializer)', () => {
      it('binds a default Serializer factory at the serializer.Serializer slot', () => {
         const module = moduleView(emptyContext);
         expect(module.serializer.Serializer).toBeDefined();
         expect(typeof module.serializer.Serializer).toBe('function');
      });

      it('throws with a clear error naming the slot when serialize() is called', () => {
         const module = moduleView(emptyContext);
         const serializer = module.serializer.Serializer(emptyServices);
         expect(() => serializer.serializeAst({} as AstNode)).toThrow(/No Serializer registered/);
      });

      it('throws an error that names the per-language module factory in its remediation hint', () => {
         const module = moduleView(emptyContext);
         const serializer = module.serializer.Serializer(emptyServices);
         expect(() => serializer.serializeAst({} as AstNode)).toThrow(/per-language module/);
      });

      it('throws an error that names the slot path adopters should bind', () => {
         const module = moduleView(emptyContext);
         const serializer = module.serializer.Serializer(emptyServices);
         expect(() => serializer.serializeAst({} as AstNode)).toThrow(/services\.serializer\.Serializer/);
      });
   });

   describe('references.NameProvider default binding', () => {
      it('binds a DefaultNameProvider with the default `.` separator', () => {
         const module = moduleView(emptyContext);
         const sharedStub = {
            shared: {
               workspace: {
                  ProjectManager: { getProject: () => undefined },
                  DocumentBuilder: { onUpdate: () => Disposable.EMPTY }
               }
            }
         } as unknown as LangiumCoreServices;
         const nameProvider = module.references.NameProvider(sharedStub);
         expect(nameProvider).toBeInstanceOf(DefaultNameProvider);
         expect(nameProvider.nameSeparator).toBe('.');
      });
   });

   describe('references.ElementKeyProvider default binding', () => {
      it('binds a DefaultElementKeyProvider that reads the separator through the NameProvider slot', () => {
         const module = moduleView(emptyContext);
         const elementKeyProvider = module.references.ElementKeyProvider(servicesWithNameProvider());
         expect(elementKeyProvider).toBeInstanceOf(DefaultElementKeyProvider);
      });
   });
});
