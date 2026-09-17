/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Whether a configuration section nobody named after a language id is ever asked
 * about. Each direction is pinned: the section must be requested, it must be
 * requested only once, and it must not be requested at all of a client that
 * declared no `workspace.configuration`.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ConfigurationItem, InitializeParams } from 'vscode-languageserver';
import { HydraniumConfigurationProvider } from '../../../src/langium/config/configuration-provider.js';
import type { LangiumSharedCoreServices } from '@hydranium/langium';

const LANGUAGE_ID = 'demo-lang';
const PROJECT_ROOT = 'demo';

/** Services stub reaching only `ServiceRegistry.all`, which is all the base provider reads. */
function makeServicesStub(): LangiumSharedCoreServices {
   return {
      ServiceRegistry: { all: [{ LanguageMetaData: { languageId: LANGUAGE_ID } }] }
   } as unknown as LangiumSharedCoreServices;
}

interface Harness {
   readonly provider: HydraniumConfigurationProvider;
   /** Every section the provider asked the client for, in request order. */
   readonly fetched: string[];
   /** Every section the provider registered for change notifications. */
   readonly registered: string[];
}

/**
 * Boot a provider through the real `initialize` / `initialized` handshake, with
 * the client answering `values` per section. A section absent from `values`
 * answers `null`, which is what a client sends for a setting with no value.
 *
 * The hooks are supplied whatever `capabilities` says, matching a real
 * connection, which binds them before reading the client's declaration.
 * Withholding them for a client that declared nothing would make the hooks
 * themselves the guard and leave the capability check unprobed.
 */
async function boot(
   values: Record<string, unknown>,
   capabilities: InitializeParams['capabilities'] = { workspace: { configuration: true } }
): Promise<Harness> {
   const provider = new HydraniumConfigurationProvider(makeServicesStub());
   const fetched: string[] = [];
   const registered: string[] = [];

   provider.initialize({ capabilities } as unknown as InitializeParams);
   await provider.initialized({
      register: params => {
         const section = params.section;
         registered.push(...(Array.isArray(section) ? section : [section ?? '']));
      },
      fetchConfiguration: (items: ConfigurationItem[]) =>
         Promise.resolve(
            items.map(item => {
               fetched.push(item.section ?? '');
               return values[item.section ?? ''] ?? null;
            })
         )
   });

   return { provider, fetched, registered };
}

describe('HydraniumConfigurationProvider', () => {
   it('asks the client about a section that is not a language id', async () => {
      const { provider, fetched } = await boot({ [PROJECT_ROOT]: { log: { level: 'debug' } } });
      // Control: the handshake fetched the language section and nothing else, so
      // the assertion below cannot pass on the initial pass alone.
      expect(fetched).toEqual([LANGUAGE_ID]);

      const log = await provider.getConfiguration(PROJECT_ROOT, 'log');

      expect(log).toEqual({ level: 'debug' });
      expect(fetched).toEqual([LANGUAGE_ID, PROJECT_ROOT]);
   });

   it('registers for the section, so a later user edit arrives', async () => {
      const { provider, registered } = await boot({ [PROJECT_ROOT]: { log: { level: 'debug' } } });

      await provider.getConfiguration(PROJECT_ROOT, 'log');

      expect(registered).toContain(PROJECT_ROOT);
   });

   it('serves a second read from the store instead of asking again', async () => {
      const { provider, fetched } = await boot({ [PROJECT_ROOT]: { log: { level: 'debug' } } });

      await provider.getConfiguration(PROJECT_ROOT, 'log');
      await provider.getConfiguration(PROJECT_ROOT, 'log');

      expect(fetched.filter(section => section === PROJECT_ROOT)).toHaveLength(1);
   });

   it('asks once about a section the user has never set, not once per read', async () => {
      // The store cannot tell "unset" from "not yet fetched" — both are absent —
      // so remembering the ATTEMPT is what bounds the traffic.
      const { provider, fetched } = await boot({});

      expect(await provider.getConfiguration(PROJECT_ROOT, 'log')).toBeUndefined();
      expect(await provider.getConfiguration(PROJECT_ROOT, 'log')).toBeUndefined();

      expect(fetched.filter(section => section === PROJECT_ROOT)).toHaveLength(1);
   });

   it('shares one request between concurrent readers', async () => {
      const { provider, fetched } = await boot({ [PROJECT_ROOT]: { log: { level: 'debug' }, trace: { server: 'off' } } });

      const [log, trace] = await Promise.all([
         provider.getConfiguration(PROJECT_ROOT, 'log'),
         provider.getConfiguration(PROJECT_ROOT, 'trace')
      ]);

      expect(log).toEqual({ level: 'debug' });
      expect(trace).toEqual({ server: 'off' });
      expect(fetched.filter(section => section === PROJECT_ROOT)).toHaveLength(1);
   });

   it('leaves a language section to the base handshake', async () => {
      const { provider, fetched } = await boot({ [LANGUAGE_ID]: { feature: { enabled: true } } });

      expect(await provider.getConfiguration(LANGUAGE_ID, 'feature')).toEqual({ enabled: true });
      expect(fetched).toEqual([LANGUAGE_ID]);
   });

   it('asks a client that declared no `workspace.configuration` about nothing', async () => {
      // A client answering here is what makes this discriminating: the section
      // HAS a value, so a provider that asks gets one back and the read below
      // resolves it.
      const { provider, fetched, registered } = await boot({ [PROJECT_ROOT]: { log: { level: 'debug' } } }, {});

      expect(await provider.getConfiguration(PROJECT_ROOT, 'log')).toBeUndefined();

      expect(registered).toEqual([]);
      expect(fetched).toEqual([]);
   });

   it('falls back to the base behaviour with no client hooks', async () => {
      // A headless composition has no connection, so `initialized` arrives
      // without `register` / `fetchConfiguration`. Reading must answer rather
      // than throw on the absent hooks.
      const provider = new HydraniumConfigurationProvider(makeServicesStub());
      provider.initialize({ capabilities: {} } as unknown as InitializeParams);
      await provider.initialized({});

      await expect(provider.getConfiguration(PROJECT_ROOT, 'log')).resolves.toBeUndefined();
   });

   it('keeps the push path working for a lazily fetched section', async () => {
      // The registration above is what makes the client send these, and the
      // update has to reach subscribers — that is how a live setting change is
      // delivered once the initial read has happened.
      const { provider } = await boot({ [PROJECT_ROOT]: { log: { level: 'debug' } } });
      await provider.getConfiguration(PROJECT_ROOT, 'log');
      const listener = vi.fn();
      provider.onConfigurationSectionUpdate(listener);

      provider.updateConfiguration({ settings: { [PROJECT_ROOT]: { log: { level: 'trace' } } } });

      expect(listener).toHaveBeenCalledWith({ section: PROJECT_ROOT, configuration: { log: { level: 'trace' } } });
      expect(await provider.getConfiguration(PROJECT_ROOT, 'log')).toEqual({ level: 'trace' });
   });
});
