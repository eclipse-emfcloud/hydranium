/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `makeNoopSharedServices` and its per-language sibling
 * `makeNoopLanguageServices`, measured on the wiring they promise.
 *
 * Neither has a type to conform to — the return value is cast at the boundary
 * on purpose, so that the many Langium slots a unit test never touches can stay
 * absent. That cast is also what makes a wiring mistake invisible: every slot
 * reads as its declared type whether or not anything was bound, so a service
 * that stopped being wired surfaces as `undefined` inside whichever consumer
 * happens to read it, several layers from the change.
 *
 * The claims asserted here are the ones a consumer cannot see going wrong:
 *
 * - The three observability defaults are the real framework classes, not
 *   look-alikes, since a test that binds a `Tracer` slot expects real fluent
 *   derivation from it.
 * - An overridden `Logger` is bound on its own slot AND wrapped by the default
 *   `Tracer`, and an overridden `Clock` reaches that same tracer. Both are
 *   documented; together they are what makes `makeCapturingLogger` +
 *   `makeFakeClock` see tracer-emitted timing lines, which is the reason to
 *   pass either.
 * - An unlisted `workspace` slot resolves to `undefined` rather than to an
 *   empty stand-in, so a service reading a slot the test forgot fails loudly
 *   instead of being answered.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultTracer, Logger, NoopLogger, SystemClock, type LogThreshold } from '@hydranium/protocol';
import { makeFakeClock } from '@hydranium/protocol/testing';
import type { ServerSharedServicesMinimal } from '../../src/langium/shared-services.js';
import {
   makeCapturingLogger,
   makeCapturingTracer,
   makeNoopLanguageServices,
   makeNoopSharedServices,
   makeStubLangiumDocuments
} from '../../src/testing/index.js';

let entryLevel: LogThreshold;

beforeEach(() => {
   entryLevel = Logger.getLevel();
   Logger.setLevel('info');
});

afterEach(() => {
   Logger.setLevel(entryLevel);
});

/** Read a slot the minimal tree does not declare, without a per-assertion cast. */
function slot(services: ServerSharedServicesMinimal, name: string): unknown {
   return (services as unknown as Record<string, unknown>)[name];
}

describe('makeNoopSharedServices — the defaults', () => {
   it('binds the real framework observability classes, not stand-ins', () => {
      const services = makeNoopSharedServices();

      expect(services.Clock).toBeInstanceOf(SystemClock);
      expect(services.Logger).toBeInstanceOf(NoopLogger);
      expect(services.Tracer).toBeInstanceOf(DefaultTracer);
      expect(slot(services, 'additionalDocuments')).toEqual({});
   });

   it('composes the default Tracer over the default Logger and Clock', () => {
      const services = makeNoopSharedServices();
      const composed = services.Tracer as unknown as { logger: unknown; clock: unknown };

      expect(composed.logger).toBe(services.Logger);
      expect(composed.clock).toBe(services.Clock);
   });

   it('leaves every workspace slot it was not given absent', () => {
      const services = makeNoopSharedServices();

      expect(services.workspace).toEqual({});
      expect(services.workspace.LangiumDocuments).toBeUndefined();
      expect(services.workspace.DocumentBuilder).toBeUndefined();
   });
});

describe('makeNoopSharedServices — the overrides', () => {
   it('binds an overridden Logger on its own slot and threads it into the default Tracer', () => {
      const { logger, lines } = makeCapturingLogger();
      const services = makeNoopSharedServices({ Logger: logger });

      expect(services.Logger).toBe(logger);
      services.Tracer.for('Subject').info('through-the-tracer');

      // The documented reason to pass a capturing logger: tracer-emitted lines
      // land on the same sink. A tracer built over its own NoopLogger would
      // leave this empty while every other assertion still passed.
      expect(lines.map(line => line.message)).toEqual(['through-the-tracer']);
   });

   it('threads an overridden Clock into the default Tracer, so timing runs on fake time', () => {
      const clock = makeFakeClock();
      const { logger, lines } = makeCapturingLogger();
      const services = makeNoopSharedServices({ Clock: clock, Logger: logger });

      expect(services.Clock).toBe(clock);
      services.Tracer.time('probe', () => clock.advance(120));

      // On the SystemClock default a synchronous span emits nothing at all (the
      // deferred start deadline never arrives), so a non-empty capture here is
      // only reachable if the injected clock reached the tracer.
      expect(lines.map(line => line.message.replace(/#\d+/, '#N'))).toEqual(['probe [#N start]', 'probe [#N done, 120ms]']);
   });

   it('binds an explicit Tracer verbatim instead of wrapping the Logger', () => {
      const { logger, lines } = makeCapturingLogger();
      const capturing = makeCapturingTracer();
      const services = makeNoopSharedServices({ Logger: logger, Tracer: capturing.tracer });

      expect(services.Tracer).toBe(capturing.tracer);
      services.Tracer.info('to-the-explicit-tracer');

      expect(capturing.lines.map(line => line.message)).toEqual(['to-the-explicit-tracer']);
      expect(lines).toEqual([]);
   });

   it('carries the workspace slots it was given, and any top-level slot besides', () => {
      const documents = makeStubLangiumDocuments();
      const reflection = { isSubtype: (): boolean => false };
      const services = makeNoopSharedServices({
         AstReflection: reflection,
         additionalDocuments: { extra: 'value' },
         workspace: { LangiumDocuments: documents }
      });

      expect(services.workspace.LangiumDocuments).toBe(documents);
      expect(slot(services, 'AstReflection')).toBe(reflection);
      expect(slot(services, 'additionalDocuments')).toEqual({ extra: 'value' });
   });

   it('copies the workspace overrides rather than aliasing the caller object', () => {
      const overrides: Record<string, unknown> = {};
      const services = makeNoopSharedServices({ workspace: overrides });
      overrides.LangiumDocuments = makeStubLangiumDocuments();

      // Aliasing would let a mutation after construction reach a tree the code
      // under test already holds, which is the opposite of the "unset slots
      // read undefined" contract above.
      expect(services.workspace.LangiumDocuments).toBeUndefined();
   });
});

describe('makeNoopLanguageServices — the shared sub-tree', () => {
   it('routes shared overrides through makeNoopSharedServices and spreads the rest per-language', () => {
      const { logger, lines } = makeCapturingLogger();
      const scopeProvider = { getScope: (): undefined => undefined };
      const language = makeNoopLanguageServices({
         shared: { Logger: logger },
         references: { ScopeProvider: scopeProvider }
      });

      expect(language.shared.Logger).toBe(logger);
      expect(language.shared.Tracer).toBeInstanceOf(DefaultTracer);
      expect(language.references.ScopeProvider).toBe(scopeProvider);

      // Same claim as the shared case, one level down: the tracer on the shared
      // sub-tree has to be the one wrapping the caller's logger.
      language.shared.Tracer.info('through-the-language-tree');
      expect(lines.map(line => line.message)).toEqual(['through-the-language-tree']);
   });

   it('leaves a per-language slot it was not given absent', () => {
      const language = makeNoopLanguageServices();

      expect(language.shared.Logger).toBeInstanceOf(NoopLogger);
      expect(language.references).toBeUndefined();
   });
});
