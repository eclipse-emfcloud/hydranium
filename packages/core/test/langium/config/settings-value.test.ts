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

/**
 * Minimal `ConfigurationProvider` stub: a `ready` promise the test
 * controls, a `getConfiguration(language, configuration)` that returns
 * a slice from a hand-rolled cache, and an `onConfigurationSectionUpdate`
 * driven by an `Emitter`. Mirrors the surface `Settings.value` reaches
 * for — anything else throws so we notice if the helper grows new deps.
 */
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

function makeServicesStub(opts: { provider: unknown; configurationRoot?: string }): ServerSharedServices {
   return {
      workspace: { ConfigurationProvider: opts.provider },
      lsp: { configurationRoot: opts.configurationRoot ?? 'inferred-root' }
   } as unknown as ServerSharedServices;
}

/** Flush microtasks so `provider.ready.then(...)` callbacks complete. */
async function flushMicrotasks(): Promise<void> {
   await Promise.resolve();
   await Promise.resolve();
   await Promise.resolve();
}

describe('Settings.value', () => {
   it('returns the default before the initial fetch resolves', () => {
      const { provider } = makeProviderStub();
      const services = makeServicesStub({ provider });
      const value = Settings.value<{ updateDelayMs?: number }, number>({
         services,
         root: 'lang',
         configuration: 'editor',
         default: 500,
         select: subtree => subtree?.updateDelayMs ?? 500
      });
      expect(value.value).toBe(500);
   });

   it('applies the fetched value once `provider.ready` resolves', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { updateDelayMs: 200 } };
      const services = makeServicesStub({ provider: stub.provider });
      const value = Settings.value<{ updateDelayMs?: number }, number>({
         services,
         root: 'lang',
         configuration: 'editor',
         default: 500,
         select: subtree => subtree?.updateDelayMs ?? 500
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(200);
   });

   it('falls back to `lsp.configurationRoot` when `root` is omitted', async () => {
      const stub = makeProviderStub();
      stub.settings['inferred-root'] = { editor: { updateDelayMs: 750 } };
      const services = makeServicesStub({ provider: stub.provider, configurationRoot: 'inferred-root' });
      const value = Settings.value<{ updateDelayMs?: number }, number>({
         services,
         configuration: 'editor',
         default: 0,
         select: subtree => subtree?.updateDelayMs ?? 0
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(750);
   });

   it('fires `onChange` when the selected slice changes via a section update', async () => {
      const stub = makeProviderStub();
      const services = makeServicesStub({ provider: stub.provider });
      const value = Settings.value<{ updateDelayMs?: number }, number>({
         services,
         root: 'lang',
         configuration: 'editor',
         default: 0,
         select: subtree => subtree?.updateDelayMs ?? 0
      });
      const received: number[] = [];
      value.onChange(next => received.push(next));
      stub.resolveReady();
      await flushMicrotasks();

      stub.fireUpdate({ section: 'lang', configuration: { editor: { updateDelayMs: 100 } } });
      stub.fireUpdate({ section: 'lang', configuration: { editor: { updateDelayMs: 250 } } });
      expect(received).toEqual([100, 250]);
      expect(value.value).toBe(250);
   });

   it('does NOT fire `onChange` for unrelated section updates (different root)', async () => {
      const stub = makeProviderStub();
      const services = makeServicesStub({ provider: stub.provider });
      const value = Settings.value<{ updateDelayMs?: number }, number>({
         services,
         root: 'lang',
         configuration: 'editor',
         default: 0,
         select: subtree => subtree?.updateDelayMs ?? 0
      });
      const received: number[] = [];
      value.onChange(next => received.push(next));
      stub.resolveReady();
      await flushMicrotasks();

      stub.fireUpdate({ section: 'other-lang', configuration: { editor: { updateDelayMs: 999 } } });
      expect(received).toEqual([]);
   });

   it('does NOT fire `onChange` when the selected slice is unchanged', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { updateDelayMs: 100 } };
      const services = makeServicesStub({ provider: stub.provider });
      const value = Settings.value<{ updateDelayMs?: number }, number>({
         services,
         root: 'lang',
         configuration: 'editor',
         default: 0,
         select: subtree => subtree?.updateDelayMs ?? 0
      });
      const received: number[] = [];
      value.onChange(next => received.push(next));
      stub.resolveReady();
      await flushMicrotasks();
      // Initial fetch changes default (0) -> 100 — one fire expected.
      expect(received).toEqual([100]);

      // Update with the same value AND with an unrelated sibling key.
      stub.fireUpdate({ section: 'lang', configuration: { editor: { updateDelayMs: 100 }, other: 'ignored' } });
      expect(received).toEqual([100]);
   });

   it('falls back to the default when `select` returns undefined or null', async () => {
      // Pins the null/undefined → default branch: a section update arrives and
      // `select` yields `undefined` (then `null`), so the snapshot must stay at
      // the default rather than adopting the nullish value.
      const stub = makeProviderStub();
      const services = makeServicesStub({ provider: stub.provider });
      const value = Settings.value<{ updateDelayMs?: number }, number>({
         services,
         root: 'lang',
         configuration: 'editor',
         default: 77,
         select: subtree => subtree?.updateDelayMs // undefined when the key is absent
      });
      const received: number[] = [];
      value.onChange(next => received.push(next));
      stub.resolveReady();
      await flushMicrotasks();

      // Slice present but `updateDelayMs` absent → select returns undefined.
      stub.fireUpdate({ section: 'lang', configuration: { editor: { unrelated: true } } });
      expect(value.value).toBe(77);
      // No change away from the default means no fire.
      expect(received).toEqual([]);
   });

   it('keeps the default when `select` throws', async () => {
      const stub = makeProviderStub();
      stub.settings['lang'] = { editor: { weird: true } };
      const services = makeServicesStub({ provider: stub.provider });
      const value = Settings.value<{ updateDelayMs: number }, number>({
         services,
         root: 'lang',
         configuration: 'editor',
         default: 42,
         select: subtree => {
            if (typeof subtree.updateDelayMs !== 'number') {
               throw new Error('not a number');
            }
            return subtree.updateDelayMs;
         }
      });
      stub.resolveReady();
      await flushMicrotasks();
      expect(value.value).toBe(42);
   });
});
