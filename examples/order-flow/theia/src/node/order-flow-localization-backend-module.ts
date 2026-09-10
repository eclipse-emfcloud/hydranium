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
 * Registers the German catalogue for the messages THIS FRONTEND renders.
 *
 * # Two catalogues, split by which side renders
 *
 * The framework externalizes user-facing strings and selects no locale; each
 * carries a stable `hydranium/<unscoped-package>/<name>` code beside its English
 * text, and the side that knows the reading user's language renders it. Since
 * that side differs per message, so do the catalogues — and their key sets are
 * disjoint, which a test in this package asserts:
 *
 * - **Here** are the strings this frontend renders: the host-bound ones
 *   (`hydranium/client-theia/*`) that Theia resolves through `nls.localize`, and
 *   the portable client tier's own (`hydranium/protocol/*`,
 *   `order-flow/properties/*`), which reach a user through
 *   `OrderFlowTheiaDataPort.reportError`. Those fire when the data server is
 *   unreachable, so no server could have worded them.
 * - **In the server package** are the messages the SERVER renders — its
 *   diagnostics, this example's validation codes, Langium's
 *   unresolved-reference sentence. It is handed a locale at LSP `initialize`
 *   and renders before sending, so nothing on this side re-renders them.
 *   Doing so would put two authorities on one sentence.
 *
 * Codes land in one flat map because Theia flattens a nested catalogue by
 * joining keys with `/` — the same separator the codes use. Adopter-owned codes
 * (`order-flow/*`) sit under their own namespace; `hydranium/` is reserved for
 * the framework.
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
 * devtools) and reload. That also reaches the server: Theia initializes its
 * plugin host with the frontend's locale, the sideloaded servers extension runs
 * there, and `vscode-languageclient` puts `env.language` in `initialize`. So
 * one switch changes both the shell's German and the squiggles' — including a
 * PARAMETERISED diagnostic, which client-side rendering could never reach,
 * Monaco's marker model having no field for the params.
 *
 * Nothing on this BACKEND selects a locale, and nothing can: it serves every
 * connected frontend at once. That is why the locale is declared per LSP
 * connection rather than held here.
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
