/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The page's entry point, and it exists to do exactly one thing before the page
 * does anything else: put MONACO's own language in place.
 *
 * # Why this is a separate module at all
 *
 * `monaco-editor-core` ships thirteen locale bundles beside its code —
 * `esm/nls.messages.de.js` and siblings — each of which is a plain script
 * assigning `globalThis._VSCODE_NLS_MESSAGES` and `_VSCODE_NLS_LANGUAGE`. The
 * distribution is the BUILT form of Monaco's NLS, so a call site reads
 * `nls.localize(849, "Cu&&t")` and `lookupMessage` indexes that global.
 *
 * **The lookups that matter do not happen when the menu opens; they happen when
 * the module is evaluated.** Monaco registers its context-menu entries at module
 * scope — `MenuRegistry.appendMenuItem(MenuId.EditorContext, { title:
 * nls.localize2(862, "Copy As"), … })` is a top-level statement, and every
 * editor action's title is resolved in a constructor the module runs itself. So
 * a global set after `monaco-editor-core` has loaded arrives too late for the
 * right-click menu, however early in the page's own startup it looks.
 *
 * That makes the ordering a MODULE-GRAPH problem rather than a startup-sequence
 * one, and ES module semantics decide it: a static import is hoisted above the
 * importing module's first statement, so nothing this file could execute would
 * precede Monaco. A dynamic `import()` is the one form that defers, and
 * esbuild preserves that in a single-file `iife` bundle — measured: with a
 * static import the dependency's body runs before the entry's first line, and
 * with a dynamic one it runs at the `await`.
 *
 * Hence the split. Everything about the page lives in `workbench.ts`, which
 * imports Monaco; this module holds no import that reaches it, and loads it
 * only once the locale is decided.
 *
 * # What is deliberately NOT localized
 *
 * **Monaco's editor worker.** `monaco-editor-worker.ts` is its own bundle and
 * gets no catalogue: the operations it runs off the main thread — diff, minimal
 * edits, link detection, word-based completions — return positions and ranges,
 * not prose. Handing it a locale would mean threading one through
 * `MonacoEnvironment.getWorker` for strings no user sees.
 */

import { requireElement } from './dom.js';
import { requestedLocale } from './page-nls.js';

/**
 * Monaco's locale bundles, by the same code the page's own switch uses.
 *
 * Thunks rather than a table of specifiers, because the deferral is the point:
 * each entry has to stay an unevaluated `import()` until one is chosen, and a
 * map of already-resolved modules would have loaded all of them.
 *
 * Partial, like the chrome catalogue beside it — a code with no entry here
 * leaves Monaco in its built-in English, which is the same degradation an
 * adopter gets for a language Monaco does not ship. It stays a subset of what
 * `PAGE_LOCALES` offers rather than the full thirteen: offering a language whose
 * page chrome is untranslated would put a German editor menu in an English page.
 */
const MONACO_CATALOGUES: Readonly<Record<string, () => Promise<unknown>>> = {
   de: () => import('monaco-editor-core/esm/nls.messages.de.js')
};

/**
 * Load Monaco's catalogue for `locale`, or leave its English in place.
 *
 * The bundle is a side-effecting script with nothing to import FROM it — it
 * assigns two globals and exports nothing — so the returned module object is
 * discarded and the `await` is the entire contract.
 */
async function loadMonacoLocale(locale: string | undefined): Promise<void> {
   const catalogue = locale === undefined ? undefined : MONACO_CATALOGUES[locale];
   if (catalogue !== undefined) {
      await catalogue();
   }
}

/**
 * Decide the language, then build the page in it.
 *
 * Not a top-level `await`: esbuild rejects one in `iife` output, which is the
 * format this bundle has to be in to load as a classic `<script>`.
 */
async function boot(): Promise<void> {
   const locale = requestedLocale();
   await loadMonacoLocale(locale);
   // The FIRST statement that may reach Monaco, and it has to stay that way.
   const { main } = await import('./workbench.js');
   await main(locale);
}

boot().catch((error: unknown) => {
   // Written straight to the element rather than through `workbench.ts`'s
   // `setStatus`: importing that helper would import the module this file exists
   // to load late, and the failure being reported here is most likely that the
   // module never loaded at all.
   requireElement('status').textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
});
