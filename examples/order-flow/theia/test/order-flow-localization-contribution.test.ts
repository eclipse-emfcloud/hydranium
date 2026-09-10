/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LocalizationRegistry } from '@theia/core/lib/node/i18n/localization-contribution';
import { LocalizationProvider } from '@theia/core/lib/node/i18n/localization-provider';
import { beforeEach, describe, expect, it } from 'vitest';
import { OrderFlowLocalizationContribution } from '../src/node/order-flow-localization-backend-module';

/**
 * Drives the contribution through Theia's OWN registry and provider, because the
 * two ways this registration silently does nothing are both decided inside them
 * and neither is visible in the catalogue file:
 *
 * - `getAvailableLanguages()` filters on `languagePack`, so a registration
 *   without it is offered by *Configure Display Language* to nobody; and
 * - `LocalizationServerImpl.loadLocalization` gates on that same list before
 *   loading, and the frontend preload discards a loaded localization that lacks
 *   the flag — resetting the locale to the default.
 *
 * Both failures present as "everything stays English", with no error anywhere.
 * Asserting against Theia's own code rather than re-deriving its rules is the
 * point: a rule restated here would keep passing after Theia changed it.
 *
 * The sibling suite checks the catalogue's KEYS. This one checks that the
 * catalogue is reachable at all.
 */

/**
 * `LocalizationRegistry` takes its collaborators by property injection, and the
 * `contributions` provider is used only by `initialize()`, which this drives by
 * hand instead. Assigning the one field a test needs is narrower than standing
 * up a container.
 */
function makeRegistry(provider: LocalizationProvider): LocalizationRegistry {
   const registry = new LocalizationRegistry();
   Object.assign(registry, { localizationProvider: provider });
   return registry;
}

describe('the German localization contribution', () => {
   let provider: LocalizationProvider;

   beforeEach(async () => {
      provider = new LocalizationProvider();
      await new OrderFlowLocalizationContribution().registerLocalizations(makeRegistry(provider));
   });

   it('offers German to the display-language picker', () => {
      // No argument, exactly as `LanguageQuickPickService.getInstalledLanguages`
      // calls it — which is what applies the `languagePack` filter.
      const offered = provider.getAvailableLanguages();

      expect(offered.map(language => language.languageId)).toContain('de');
      expect(offered.find(language => language.languageId === 'de')?.localizedLanguageName).toBe('Deutsch');
   });

   it('loads the catalogue, rather than a path that resolves nowhere', async () => {
      // The catalogue is imported rather than read from a `__dirname`-relative
      // path: under the webpack-bundled backend that path lands in the
      // application directory and the read rejects. A rejection here would fail
      // this test, which is the only reason to await the load rather than
      // inspect the registration.
      const localization = await provider.loadLocalization('de');

      expect(localization.languagePack).toBe(true);
      // Flattened on `/` by the registry, which is what makes the framework's
      // own `hydranium/<package>/<name>` codes usable as catalogue keys.
      expect(localization.translations['hydranium/protocol/data-server-connect-failed']).toBe(
         'Verbindung zum Datenserver fehlgeschlagen: {detail}'
      );
   });
});
