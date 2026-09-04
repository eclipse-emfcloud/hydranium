/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { Emitter } from 'vscode-languageserver';
import { Settings } from '../../../src/langium/config/settings.js';
import type { ServerSharedServices } from '../../../src/langium/module.js';

interface SectionUpdate {
   section: string;
   configuration: unknown;
}

/** Minimal `ConfigurationProvider` stub, duplicated rather than shared so the reader tests stay independent. */
function makeProviderStub() {
   const settings: Record<string, Record<string, unknown>> = {};
   let resolveReady: () => void = () => undefined;
   const ready = new Promise<void>(resolve => {
      resolveReady = resolve;
   });
   const updateEmitter = new Emitter<SectionUpdate>();
   return {
      settings,
      ready,
      resolveReady: () => resolveReady(),
      fireUpdate: (update: SectionUpdate) => updateEmitter.fire(update),
      provider: {
         ready,
         getConfiguration: async (language: string, configuration: string): Promise<unknown> => {
            await ready;
            return settings[language]?.[configuration];
         },
         onConfigurationSectionUpdate: updateEmitter.event
      }
   };
}

function makeServicesStub(provider: unknown): ServerSharedServices {
   return {
      workspace: { ConfigurationProvider: provider },
      lsp: { configurationRoot: 'lang' }
   } as unknown as ServerSharedServices;
}

async function flushMicrotasks(): Promise<void> {
   for (let i = 0; i < 3; i++) {
      await Promise.resolve();
   }
}

describe('Settings.number', () => {
   it('reads a numeric value at the configured key', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { updateDelayMs: 200 } };
      const value = Settings.number({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'updateDelayMs',
         default: 500
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(200);
   });

   it('coerces string-typed values via Number.parseFloat by default', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { updateDelayMs: '350' } };
      const value = Settings.number({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'updateDelayMs',
         default: 500
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(350);
   });

   it('falls back to default when the string cannot be coerced', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { updateDelayMs: 'not-a-number' } };
      const value = Settings.number({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'updateDelayMs',
         default: 500
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(500);
   });

   it('falls back to default when `coerceString: false` is set and the value is a string', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { updateDelayMs: '200' } };
      const value = Settings.number({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'updateDelayMs',
         default: 500,
         coerceString: false
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(500);
   });

   it('rejects non-finite numbers', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { updateDelayMs: Number.POSITIVE_INFINITY } };
      const value = Settings.number({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'updateDelayMs',
         default: 500
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(500);
   });

   it('rejects negative values when `nonNegative: true`', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { updateDelayMs: -100 } };
      const value = Settings.number({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'updateDelayMs',
         default: 500,
         nonNegative: true
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(500);
   });

   it('rounds to integer via Math.round when `integer: true`', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { updateDelayMs: 234.7 } };
      const value = Settings.number({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'updateDelayMs',
         default: 500,
         integer: true
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(235);
   });

   it('rejects values outside the `min`/`max` range', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { updateDelayMs: 5000 } };
      const value = Settings.number({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'updateDelayMs',
         default: 500,
         min: 0,
         max: 2000
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(500);
   });

   it('pins the nonNegative / min / max boundaries (accept-vs-reject edges)', async () => {
      const cases: Array<{ raw: number; opts: { nonNegative?: boolean; min?: number; max?: number }; expected: number }> = [
         { raw: 0, opts: { nonNegative: true }, expected: 0 }, // boundary value accepted
         { raw: 5, opts: { nonNegative: true }, expected: 5 }, // positive accepted (kills && -> ||)
         { raw: 100, opts: { min: 100 }, expected: 100 }, // value === min accepted (kills < -> <=)
         { raw: 150, opts: { min: 100 }, expected: 150 }, // above min accepted
         { raw: 50, opts: { min: 100 }, expected: 500 }, // below min rejected (kills the min guard)
         { raw: 2000, opts: { max: 2000 }, expected: 2000 }, // value === max accepted (kills > -> >=)
         { raw: 1999, opts: { max: 2000 }, expected: 1999 } // below max accepted (kills && -> ||)
      ];
      for (const { raw, opts, expected } of cases) {
         const stub = makeProviderStub();
         stub.settings['lang'] = { editor: { updateDelayMs: raw } };
         const value = Settings.number({
            services: makeServicesStub(stub.provider),
            configuration: 'editor',
            key: 'updateDelayMs',
            default: 500,
            ...opts
         });
         stub.resolveReady();
         await flushMicrotasks();
         expect(value.value).toBe(expected);
      }
   });

   it('accepts an array `key` for deep traversal', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { advanced: { updateDelayMs: 750 } } };
      const value = Settings.number({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: ['advanced', 'updateDelayMs'],
         default: 500
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(750);
   });

   it('falls back to default when an intermediate path segment is missing', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = {
         editor: {/* `advanced` missing */}
      };
      const value = Settings.number({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: ['advanced', 'updateDelayMs'],
         default: 500
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(500);
   });
});

describe('Settings.boolean', () => {
   it('reads a boolean value at the configured key', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { features: { enableX: true } };
      const value = Settings.boolean({
         services: makeServicesStub(stub.provider),
         configuration: 'features',
         key: 'enableX',
         default: false
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(true);
   });

   it("coerces 'true' / 'false' / '1' / '0' string values (case-insensitive) by default", async () => {
      const cases: Array<[unknown, boolean]> = [
         ['true', true],
         ['TRUE', true],
         ['  true ', true],
         ['1', true],
         ['false', false],
         ['False', false],
         ['0', false]
      ];
      for (const [raw, expected] of cases) {
         const stub = makeProviderStub();
         stub.settings['lang'] = { features: { enableX: raw } };
         const value = Settings.boolean({
            services: makeServicesStub(stub.provider),
            configuration: 'features',
            key: 'enableX',
            default: !expected // distinguish from default
         });
         stub.resolveReady();
         await flushMicrotasks();
         expect(value.value).toBe(expected);
      }
   });

   it('falls back to default for unrecognised string values', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { features: { enableX: 'maybe' } };
      const value = Settings.boolean({
         services: makeServicesStub(stub.provider),
         configuration: 'features',
         key: 'enableX',
         default: false
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(false);
   });

   it('does not coerce a string when `coerceString: false`', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { features: { enableX: 'true' } };
      const value = Settings.boolean({
         services: makeServicesStub(stub.provider),
         configuration: 'features',
         key: 'enableX',
         default: false,
         coerceString: false
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(false);
   });
});

describe('Settings.string', () => {
   it('reads a string value at the configured key', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { mode: 'compact' } };
      const value = Settings.string({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'mode',
         default: 'verbose'
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe('compact');
   });

   it('falls back to default for non-string values (when coerceToString is off)', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { mode: 42 } };
      const value = Settings.string({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'mode',
         default: 'verbose'
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe('verbose');
   });

   it('coerces non-string values when `coerceToString: true`', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { count: 42 } };
      const value = Settings.string({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'count',
         default: '',
         coerceToString: true
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe('42');
   });

   it('does not coerce null even when `coerceToString: true`', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { mode: null } };
      const value = Settings.string({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'mode',
         default: 'verbose',
         coerceToString: true
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe('verbose');
   });

   it('rejects values outside the `allowed` set', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { mode: 'unknown-mode' } };
      const value = Settings.string<'compact' | 'verbose'>({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'mode',
         default: 'verbose',
         allowed: ['compact', 'verbose']
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe('verbose');
   });

   it('accepts values inside the `allowed` set', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { mode: 'compact' } };
      const value = Settings.string<'compact' | 'verbose'>({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'mode',
         default: 'verbose',
         allowed: ['compact', 'verbose']
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe('compact');
   });
});

/**
 * Compile-time path validation tests. The `@ts-expect-error` directives
 * verify that bad paths are rejected at the type-checker level — if the
 * directive becomes unused (because the line type-checks unexpectedly),
 * tsc fails the file with "Unused '@ts-expect-error' directive". The
 * cases also exercise the loose `unknown` default so untyped call sites
 * keep their permissive shape.
 */
describe('compile-time path validation (typed TConfig)', () => {
   interface EditorConfig {
      updateDelayMs?: number;
      mode?: 'compact' | 'verbose';
      advanced?: {
         syncMode?: 'fast' | 'safe';
         retries?: number;
      };
   }

   it('accepts a valid top-level key', () => {
      const stub = makeProviderStub();
      const v = Settings.number<EditorConfig>({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'updateDelayMs',
         default: 500
      });
      expect(v.value).toBe(500);
   });

   it('accepts a valid nested-path tuple', () => {
      const stub = makeProviderStub();
      const v = Settings.number<EditorConfig>({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: ['advanced', 'retries'],
         default: 3
      });
      expect(v.value).toBe(3);
   });

   it('rejects an invalid top-level key at compile time', () => {
      const stub = makeProviderStub();
      const v = Settings.number<EditorConfig>({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         // @ts-expect-error — `wrongKey` is not a top-level key of EditorConfig
         key: 'wrongKey',
         default: 500
      });
      expect(v.value).toBe(500);
   });

   it('rejects an invalid nested-path tuple at compile time', () => {
      const stub = makeProviderStub();
      const v = Settings.number<EditorConfig>({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         // @ts-expect-error — `advanced.wrongKey` is not a valid path through EditorConfig
         key: ['advanced', 'wrongKey'],
         default: 500
      });
      expect(v.value).toBe(500);
   });

   it('keeps the untyped (default `unknown`) call-site permissive', () => {
      const stub = makeProviderStub();
      const v = Settings.number({
         services: makeServicesStub(stub.provider),
         configuration: 'editor',
         key: 'any-string-accepted', // no compile error — TConfig defaulted to unknown
         default: 500
      });
      expect(v.value).toBe(500);
   });
});
