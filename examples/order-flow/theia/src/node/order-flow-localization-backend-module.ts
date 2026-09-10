/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ContainerModule, injectable } from '@theia/core/shared/inversify';
import { LocalizationContribution, type LocalizationRegistry } from '@theia/core/lib/node/i18n/localization-contribution';
import germanCatalogue from '../nls/order-flow.de.json';

/**
 * Registers this example's German catalogue, which is how an adopter renders the
 * framework's messages in a language the framework ships nothing for.
 *
 * # One catalogue serves both framework layers
 *
 * The framework externalizes user-facing strings and never translates them: each
 * carries a stable `hydranium/<unscoped-package>/<name>` code beside its English
 * text, and whoever owns the surface renders it. Those codes land in ONE flat map
 * here, because Theia flattens a nested catalogue by joining keys with `/` — the
 * same separator the framework's codes use. So a single file covers:
 *
 * - the **host-bound** strings (`hydranium/client-theia/*`), which the Theia
 *   frontend resolves itself through `nls.localize`; and
 * - the **identity-side** ones (`hydranium/protocol/*`),
 *   which the framework only ever attaches an identity to. Those reach a user
 *   through `OrderFlowTheiaDataPort.reportError`, which hands
 *   `nls.localization?.translations` — this map — to `renderFrameworkMessage`.
 *
 * Adopter-owned codes (`order-flow/*`) sit in the same file under their own
 * namespace. `hydranium/` is reserved for the framework, so an adopter's own
 * messages must not be declared under it.
 *
 * # The validation diagnostic, and where its translation reaches
 *
 * `hydranium/core/separator-in-name` is PARAMETERISED, and it renders complete
 * in this example's properties panel: `TransferDiagnostic` carries `code` and
 * `params`, and `OrderFlowTheiaDataPort.renderDiagnostic` assembles them into
 * the sentence the panel draws. It is the entry to copy when checking whether a
 * translated diagnostic is arriving, because a missing param shows as a literal
 * `{name}` rather than as nothing.
 *
 * It does NOT reach Theia's own squiggle, hover or Problems tree, and that is a
 * decision rather than a gap: Monaco's marker model has no field for the params,
 * so the only way there is to resolve the sentence inside a rebound
 * `ProtocolToMonacoConverter` — a Theia internal that would have to be
 * re-checked at every version bump. So the framework's editor-surface advice
 * still stands: prefer a parameterless sentence FOR THE SQUIGGLE.
 *
 * # The catalogue is deliberately PARTIAL
 *
 * Only some codes are translated, and that is the demonstration rather than an
 * oversight: a code the map does not carry falls back to its English default, so
 * an adopter can translate as much or as little as they like and adopt the
 * mechanism without a catalogue at all. Running this example in German therefore
 * shows German palette entries beside English ones, which is exactly what a
 * half-finished translation looks like — and it proves the fallback path, the
 * one an adopter most needs to trust.
 *
 * # Trying it
 *
 * Theia reads the active locale from `localStorage['localeId']` in the
 * frontend, so use the *Configure Display Language* command (or set that key in
 * devtools) and reload. Nothing on the backend selects a locale, and nothing can:
 * a Theia backend serves every connected frontend at once, which is why the
 * framework holds no locale of its own and leaves the render to this side.
 *
 * The German entry appears in that command's list only because the registration
 * below declares a `languageName`; a registration that passes a bare locale
 * string is offered to nobody, so nothing in the UI can select it.
 */
@injectable()
export class OrderFlowLocalizationContribution implements LocalizationContribution {
   async registerLocalizations(registry: LocalizationRegistry): Promise<void> {
      // Imported rather than read from a path, because a Theia backend is
      // WEBPACK-BUNDLED into the application's own `lib/backend/main.js`: there
      // `__dirname` is the app directory, not this package's, so any path built
      // from it resolves under the app and the read fails with `ENOENT` — the one
      // failure this whole file exists to avoid, since a rejected localization
      // load leaves the frontend stuck at its splash. An import is resolved by
      // the bundler at build time and inlined, so it holds in both hosts. This is
      // also how Theia registers its own catalogues.
      registry.registerLocalizationFromRequire(
         {
            languageId: 'de',
            languageName: 'German',
            localizedLanguageName: 'Deutsch',
            // Registering the locale as a bare `'de'` string leaves this flag unset,
            // and Theia then discards the catalogue twice over, silently and in a way
            // no test below the app can see: `LocalizationProvider.getAvailableLanguages`
            // filters on it, so *Configure Display Language* offers English only; and
            // `I18nPreloadContribution` treats an unset flag as "does not localize
            // Theia completely" and RESETS the locale to the default rather than
            // keeping the partial catalogue. Everything stays English with no error.
            //
            // The flag's own meaning — a complete Theia language pack — is not what
            // this file is, and Theia offers no third state for a partial one. Setting
            // it is what buys a partial catalogue any effect at all; the untranslated
            // Theia strings then fall back to English exactly as an untranslated code
            // does, which is the demonstration this example wants anyway.
            languagePack: true
         },
         germanCatalogue
      );
   }
}

export default new ContainerModule(bind => {
   bind(OrderFlowLocalizationContribution).toSelf().inSingletonScope();
   bind(LocalizationContribution).toService(OrderFlowLocalizationContribution);
});
