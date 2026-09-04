/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import {
   type AstNode,
   type AstReflection,
   type LangiumCoreServices,
   type ValidationAcceptor,
   type ValidationChecks,
   ValidationRegistry
} from '@hydranium/langium';
import type { ServerLanguageServices } from '../../../src/langium/language-module.js';
import { ValidationContributionCollector } from '../../../src/langium/validation/validation-contribution-collector.js';
import { makeFakeAstNode, makeNoopTracer } from '../../../src/testing/index.js';

interface FakeNode extends AstNode {
   readonly $type: string;
}

/** Minimal `AstReflection` stub for the registry — `TypeOne` has no subtypes. */
const reflectionStub = {
   getAllSubTypes: (type: string) => [type],
   isInstance: (node: AstNode, type: string) => node?.$type === type,
   isSubtype: (subtype: string, supertype: string) => subtype === supertype
} as unknown as AstReflection;

function makeLangiumRegistry(): ValidationRegistry {
   const langiumServices = {
      shared: { AstReflection: reflectionStub }
   } as unknown as LangiumCoreServices;
   return new ValidationRegistry(langiumServices);
}

describe('ValidationContributionCollector', () => {
   it('reads `validation.checks` and calls each contribution at construction', () => {
      const calls: string[] = [];
      const services = {
         shared: { Tracer: makeNoopTracer() },
         validation: {
            ValidationRegistry: makeLangiumRegistry(),
            checks: {
               framework: {
                  registerValidationChecks: () => void calls.push('framework')
               },
               adopter: {
                  registerValidationChecks: () => void calls.push('adopter')
               }
            }
         }
      } as unknown as ServerLanguageServices;

      new ValidationContributionCollector(services);

      expect(calls.sort()).toEqual(['adopter', 'framework']);
   });

   it('threads checks through Langium ValidationRegistry — accumulating on same node type via MultiMap', async () => {
      // Two contributions both register a check for `TypeOne`. Langium's
      // ValidationRegistry stores entries in a MultiMap and `register` appends,
      // so both checks must fire — a collector that overwrote instead of
      // accumulating would silently drop one adopter's checks.
      const registry = makeLangiumRegistry();
      const services = {
         shared: { Tracer: makeNoopTracer() },
         validation: {
            ValidationRegistry: registry,
            checks: {
               first: {
                  registerValidationChecks: (reg: { register: <T>(c: ValidationChecks<T>) => void }) => {
                     reg.register<{ TypeOne: AstNode }>({
                        TypeOne: (node, accept) => accept('error', 'first', { node })
                     });
                  }
               },
               second: {
                  registerValidationChecks: (reg: { register: <T>(c: ValidationChecks<T>) => void }) => {
                     reg.register<{ TypeOne: AstNode }>({
                        TypeOne: (node, accept) => accept('error', 'second', { node })
                     });
                  }
               }
            }
         }
      } as unknown as ServerLanguageServices;

      new ValidationContributionCollector(services);

      const captured: string[] = [];
      const accept: ValidationAcceptor = (_severity, message) => {
         captured.push(message);
      };
      const checks = registry.getChecks('TypeOne');
      for (const check of checks) {
         await check(makeFakeAstNode<FakeNode>({ $type: 'TypeOne' }), accept, {} as never);
      }
      expect(captured.sort()).toEqual(['first', 'second']);
   });
});
