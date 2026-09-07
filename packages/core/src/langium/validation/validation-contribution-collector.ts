/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Tracer } from '@hydranium/protocol';
import { type ValidationCategory, type ValidationChecks, type ValidationRegistry } from '@hydranium/langium';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerLanguageServices } from '../language-module.js';
import { type ValidationCheckRegistry } from './validation-contribution.js';

export type ValidationContributionCollectorOptions = LogNameOptions;

/**
 * Per-language eager collector that wires `ValidationCheckContribution`s
 * declared under `services.validation.checks` into Langium's native
 * `ValidationRegistry`.
 *
 * Acts as the validation-side analog of the build-side
 * `BuildPipelineIntegration` routing: at construction time it iterates the
 * language's `validation.checks` contribution group, hands each contribution a
 * thin {@link ValidationCheckRegistry} adapter, and the contribution registers
 * its checks through it.
 *
 * Constructed on first per-language services access (typically forced by
 * `BuildPipelineIntegration` touching the language services tree at the first
 * build event); subsequent touches return the cached singleton from Langium's
 * DI proxy. That is what gets the checks into the registry before Langium
 * reaches the `Validated` phase — nothing else constructs this service.
 */
export class ValidationContributionCollector {
   protected readonly tracer: Tracer;

   constructor(services: ServerLanguageServices, options: ValidationContributionCollectorOptions = {}) {
      this.tracer = services.shared.Tracer.for(options.logName ?? 'ValidationContributions').trace('instantiated');
      const registry = createValidationCheckRegistry(services.validation.ValidationRegistry);
      // Optional chaining tolerates incomplete test stubs; production
      // wiring always provides the slot via `createServerLanguageModule`.
      const contributions = services.validation?.checks ?? {};
      for (const contribution of Object.values(contributions)) {
         contribution.registerValidationChecks(registry);
      }
   }
}

/**
 * Build a {@link ValidationCheckRegistry} adapter over Langium's
 * `ValidationRegistry.register` — a pass-through, so `thisObj` and `category`
 * must be forwarded rather than dropped.
 */
function createValidationCheckRegistry(langiumRegistry: ValidationRegistry): ValidationCheckRegistry {
   return {
      register<T>(checks: ValidationChecks<T>, thisObj?: ThisParameterType<unknown>, category?: ValidationCategory): void {
         langiumRegistry.register(checks, thisObj, category);
      }
   };
}
