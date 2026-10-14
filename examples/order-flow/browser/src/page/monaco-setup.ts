/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What this page supplies to Monaco that `@hydranium/client-browser` leaves to
 * the host: where its editor worker is, which languages the server speaks, the
 * themes and the scheme switch, and the editor options the page's panes want.
 *
 * # `monaco-editor-core`, not `monaco-editor`
 *
 * `monaco-editor` is core PLUS eighty bundled language definitions — Abap,
 * Bicep, Terraform — and a page whose entire subject is that its language comes
 * from a server should not ship a single one of them. `monaco-editor-core`'s
 * `module` entry is `editor.main.js`, which is `editor.all.js` (every editor
 * contribution: the suggest widget, the hover controller, the
 * document-semantic-tokens controller) plus the standalone quick-access
 * commands. One supported specifier, same API surface, no grammars.
 *
 * Trying to reach the same place from `monaco-editor` does not work cleanly:
 * `features/register.all.js` looks like the language-free entry and omits
 * `coreCommands`, `suggestController` and `documentSemanticTokens`, so composing
 * it takes about ten deep-internal specifiers no export map declares. Measured
 * on 0.56: `monaco-editor`'s root entry bundles 9.7 MB unminified against 7.6 MB
 * for that incomplete composition.
 */

import { ALL_LANGUAGES } from '@hydranium/example-order-flow-protocol';
import * as monaco from 'monaco-editor-core';

/**
 * The three order-flow languages, with the extensions their files carry.
 *
 * Taken from `order-flow-protocol`, which the server generates from its
 * grammars: the `languageId` on `didOpen` is what the server routes the
 * document to a grammar by, so a plausible-looking `order-flow` for all three
 * would parse a `.layout` file with whichever grammar answered first.
 *
 * No Monarch or TextMate grammar accompanies them, and that is the point of the
 * exercise rather than an omission — highlighting arrives from the server's
 * semantic-token provider, so there is no second definition of the language to
 * drift from the real one.
 */
export const ORDER_FLOW_LANGUAGES: readonly monaco.languages.ILanguageExtensionPoint[] = ALL_LANGUAGES.map(language => ({
   id: language.languageId,
   extensions: [...language.fileExtensions]
}));

/**
 * Monaco's own worker bundle, substituted at build time from the same constant
 * that sets esbuild's `outfile` — the same arrangement, for the same reason, as
 * the head worker's URL.
 */
declare const __MONACO_WORKER_BUNDLE_URL__: string;

/**
 * Tell Monaco where its editor worker is, before any editor is created.
 *
 * **Assigned at module scope on purpose.** Monaco reads `MonacoEnvironment`
 * lazily, on the first request that needs the worker — so an assignment inside
 * a constructor would still be early enough today and would break the moment
 * anything touched a model first. A global that must be set before an
 * unknowable first read is safest set at import time.
 *
 * `getWorker` rather than `getWorkerUrl`: the URL form is resolved against
 * Monaco's own `baseUrl` notion, which a bundled deployment does not have, while
 * the factory form lets the page construct the worker from a path it derived
 * from the build.
 */
self.MonacoEnvironment = {
   getWorker: () => new Worker(__MONACO_WORKER_BUNDLE_URL__)
};

/**
 * Which of a pair of values a colour scheme selects — the page's whole theming
 * vocabulary, shared by the editors here and the page chrome in `index.html`.
 */
export type ColourScheme = 'light' | 'dark';

/** The two themes the editors run under, by scheme. */
const ORDER_FLOW_THEMES: Readonly<Record<ColourScheme, string>> = {
   light: 'order-flow-light',
   dark: 'order-flow-dark'
};

/**
 * Colours for the semantic token types the order-flow server emits — its
 * `$type` map plus the framework's keyword pass — in both schemes.
 *
 * **In standalone Monaco a theme rule's `token` is matched against the SEMANTIC
 * TOKEN TYPE NAME directly** — `StandaloneTheme.getTokenStyleMetadata` joins the
 * type and its modifiers with `.` and matches that string against these rules.
 * That is not how VS Code works, where a semantic type reaches a colour through
 * `semanticTokenScopes` and a TextMate scope like `entity.name.type.class`. A
 * theme written the VS Code way therefore compiles, loads, and colours nothing:
 * the tokens still arrive and Monaco still splits the line into one span per
 * token, but every span resolves to the editor's default foreground. That is the
 * state this page was in before these rules existed, and it is indistinguishable
 * from the server never having answered.
 *
 * One entry per type the provider can emit, so an unstyled span means the server
 * sent a type nobody here accounted for rather than a theme that is merely thin.
 *
 * **The two schemes are PAIRED in one table rather than written as two theme
 * definitions**, because the failure of two lists is silent and asymmetric: a
 * type added to one and forgotten in the other renders correctly in whichever
 * scheme the author was looking at and defaults to the editor foreground in the
 * other, which is exactly the appearance of a server that did not answer.
 *
 * The values are the built-in themes' own semantic colours (Light Modern and
 * Dark Modern), so a reader comparing this page against VS Code sees the same
 * hue for the same kind of name — except where the built-in value does not
 * clear 4.5:1 against the editor background below, which is a step off the one
 * VS Code tunes them against. Those are darkened, and copying a value straight
 * back from VS Code reintroduces the failure.
 */
const SEMANTIC_TOKEN_COLOURS: readonly { readonly token: string; readonly light: string; readonly dark: string }[] = [
   // Declarations a field or a reference can name.
   { token: 'class', light: '247a93', dark: '4ec9b0' },
   { token: 'enum', light: '247a93', dark: '4ec9b0' },
   { token: 'enumMember', light: '0070c1', dark: '4fc1ff' },
   { token: 'property', light: '001080', dark: '9cdcfe' },
   // Flow nodes and the process that contains them.
   { token: 'function', light: '795e26', dark: 'dcdcaa' },
   { token: 'label', light: 'af00db', dark: 'c586c0' },
   { token: 'namespace', light: '247a93', dark: '4ec9b0' },
   // The two the FRAMEWORK emits from its own CST pass, driven by
   // `highlightKeywords` and `highlightComments` rather than by the adopter's
   // provider. Unlike their neighbours neither row changes anything on screen:
   // `inherit: true` pulls in `vs` / `vs-dark`, which already carry rules at
   // these very hex values, so removing either leaves its tokens the colour they
   // already are — measured, and it is why no test can hold them in place. The
   // invariant above is what they serve. A table that covers every type but one
   // relies on a base theme happening to name that one, and the day it stops the
   // symptom is a page that looks half-highlighted with nothing here to suspect.
   { token: 'keyword', light: '0000ff', dark: '569cd6' },
   { token: 'comment', light: '008000', dark: '6a9955' }
];

/**
 * The page's colour roles, per scheme, in the spelling Monaco wants.
 *
 * Monaco draws its widgets in its OWN top layer, so no stylesheet here reaches
 * them: left unset they take a VS Code palette sharing no value with the page.
 *
 * Literals rather than reads of the `--order-flow-*` properties: a theme is
 * registered at module evaluation, before `data-theme` is necessarily set, and
 * an unset variable registers black on black.
 *
 * `rim` is lighter than `border` because a shadow cannot lift a popup on a dark
 * page — black over near-black does not darken it at any alpha.
 */
const EDITOR_SURFACES: Readonly<Record<'light' | 'dark', Readonly<Record<string, string>>>> = {
   dark: {
      surface: '#24262b',
      elevated: '#2d2f34',
      border: '#393b40',
      rim: '#4d525c',
      foreground: '#e6edf3',
      muted: '#9ba0a3',
      accent: '#4daafc'
   },
   light: {
      surface: '#f9fbfc',
      elevated: '#ffffff',
      border: '#d6d8d9',
      rim: '#c9cdcf',
      foreground: '#1e2124',
      muted: '#545657',
      accent: '#0757ba'
   }
};

for (const scheme of ['light', 'dark'] as const) {
   const role = EDITOR_SURFACES[scheme];
   monaco.editor.defineTheme(ORDER_FLOW_THEMES[scheme], {
      base: scheme === 'light' ? 'vs' : 'vs-dark',
      // Inherited, so the editor's own colours (selection, line highlight, the
      // squiggle under a diagnostic) come from a complete theme rather than from
      // the rules above.
      inherit: true,
      rules: SEMANTIC_TOKEN_COLOURS.map(colour => ({ token: colour.token, foreground: colour[scheme] })),
      colors: {
         'editor.background': role.surface,
         'editor.foreground': role.foreground,
         'editorLineNumber.foreground': role.muted,
         'editorLineNumber.activeForeground': role.foreground,
         'editorGutter.background': role.surface,
         focusBorder: role.accent,
         // Every floating surface Monaco owns takes the ELEVATED role, which is
         // the same one the tool palette and the page's own dialogs sit on.
         'editorWidget.background': role.elevated,
         'editorWidget.foreground': role.foreground,
         'editorWidget.border': role.rim,
         'editorHoverWidget.background': role.elevated,
         'editorHoverWidget.foreground': role.foreground,
         'editorHoverWidget.border': role.rim,
         'editorSuggestWidget.background': role.elevated,
         'editorSuggestWidget.foreground': role.foreground,
         'editorSuggestWidget.border': role.rim,
         'editorSuggestWidget.selectedBackground': role.border,
         'editorSuggestWidget.selectedForeground': role.foreground,
         'editorSuggestWidget.highlightForeground': role.accent,
         'menu.background': role.elevated,
         'menu.foreground': role.foreground,
         'menu.border': role.rim,
         'menu.selectionBackground': role.border,
         'menu.selectionForeground': role.foreground,
         'input.background': role.surface,
         'input.foreground': role.foreground,
         'input.border': role.border,
         'list.hoverBackground': role.border,
         'list.focusBackground': role.border,
         'quickInput.background': role.elevated,
         'quickInput.foreground': role.foreground
      }
   });
}

/**
 * The scheme the editors are currently in.
 *
 * Module state, matching Monaco's own: `setTheme` is GLOBAL in standalone Monaco
 * — there is no per-editor theme — so tracking it per editor would imply a
 * choice the library cannot honour. Read by {@link editorOptions} so an editor
 * created after a switch opens in the current scheme rather than in whatever
 * the last `defineTheme` left as the default.
 */
let currentScheme: ColourScheme = 'light';

/**
 * Put every editor into `scheme`.
 *
 * Exported because the switch that drives it is the PAGE's — one control moves
 * the page chrome, the `--order-flow-*` diagram roles and this, and splitting
 * that across three independent toggles is how a themed page ends up
 * half-switched. The page owns the first two because they are CSS; this is the
 * one piece that is not.
 */
export function applyEditorScheme(scheme: ColourScheme): void {
   currentScheme = scheme;
   monaco.editor.setTheme(ORDER_FLOW_THEMES[scheme]);
}

/**
 * This page's editor options, over the client's own.
 *
 * The CURRENT scheme, not a fixed name: an editor created after a theme switch
 * would otherwise open in the other one, since `create` takes the theme it is
 * given rather than the global.
 */
export function editorOptions(): monaco.editor.IStandaloneEditorConstructionOptions {
   return {
      theme: ORDER_FLOW_THEMES[currentScheme],
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false
   };
}
