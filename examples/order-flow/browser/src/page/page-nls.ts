/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The page's own chrome, in the reader's language.
 *
 * **A plain page has no host to ask, and that is the whole reason this file
 * exists.** Every other shell in this repo gets localization from the host it
 * runs in — Theia resolves `nls.localize` against a catalogue its backend
 * registers, VS Code against a bundle it loads — and neither mechanism is
 * available to a document served over HTTP with no extension host behind it.
 * What a browser host has to supply is therefore the same thing it supplies for
 * the filesystem and the transport: a small implementation of a seam the other
 * hosts get for free.
 *
 * # The English is the document
 *
 * `index.html` carries the English text, and the catalogues are partial
 * OVERLAYS keyed by `data-nls*` attributes beside it. The alternative — every
 * string in a table here, with the markup holding empty elements — was rejected
 * because it makes the document unreadable and untestable: a page whose labels
 * exist only after script has run has no meaningful markup to review, and it
 * renders blank for exactly as long as the bundle takes to load. Keeping the
 * English in place also means a missing key degrades to English rather than to
 * nothing, which is the same fallback every catalogue in this repo has.
 *
 * # What is NOT translated, and why each is a decision
 *
 * - **`Order Flow`** — a product noun. `conventions.md` is explicit that a
 *   product name is not i18n: routing one through a catalogue asks a translator
 *   to render a name.
 * - **The status-bar category labels** — they name which head answered, and
 *   several are protocol names that have no translation, so translating the rest
 *   would leave a legend that reads half-converted. Their HINTS are translated,
 *   a hint being a sentence rather than a legend.
 * - **Every report VALUE the page computes** — `8 documents validated, 1
 *   diagnostics` and its siblings. These are measurements read against
 *   `hydranium-cli validate` from a Node process, which prints English; a
 *   translated count cannot be compared with the oracle it exists to be
 *   compared with. The README quotes them, too.
 *
 * The diagnostics in the problems list are a different case and need nothing
 * here: they are rendered SERVER-side, from the locale declared at `initialize`,
 * so they arrive already translated. That is the framework's own mechanism and
 * this file must not duplicate it.
 */

import germanChrome from './nls/order-flow-page.de.json';
import { rememberPreference, storedPreference } from './preferences.js';

/**
 * The languages the switch offers, in the order it offers them.
 *
 * `undefined` for English rather than `'en'`, because that is what the page
 * declares at `initialize` when no locale is requested — and a page that
 * declares no language is making no claim rather than claiming English. Keeping
 * the two spellings apart here is what stops the switch from sending a code the
 * server would then look up and miss.
 */
export interface PageLocale {
   /** The `?locale=` value, absent for the untranslated default. */
   readonly code?: string;
   /** How the switch names it — in that language, never translated. */
   readonly label: string;
}

export const PAGE_LOCALES: readonly PageLocale[] = [{ label: 'English' }, { code: 'de', label: 'Deutsch' }];

/**
 * The locale for the whole page: `?locale=` on the page URL, or what the last
 * visit stored.
 *
 * **The URL is the carrier, and not `navigator.language`.** The switch in the
 * title bar writes this parameter rather than holding the choice itself, which
 * keeps the state addressable: a reviewer is sent a link, and the e2e tier names
 * a language by navigating. The browser's own language would make both
 * impossible — you cannot ask a reviewer to change their browser's language to
 * see the feature, and a test cannot change it at all.
 *
 * `?locale=de` reaches this example's German catalogues; anything else falls
 * back to English, which is the same pass-through an adopter with no entry for a
 * code gets.
 *
 * **A parameter that is PRESENT outranks the store even when it is empty, and
 * that distinction is the whole reason this reads the parameter rather than its
 * value.** `?locale=` is a URL a reader reaches by clearing the tag by hand, and
 * it means English — so treating it as absent would send it to the store and
 * bring back the language the reader had just cleared. Absent entirely is the
 * only case the store answers.
 *
 * Read ONCE, by `order-flow-page.ts`, and passed to everything that needs it.
 * Three consumers now read the same value — Monaco's bundle, the chrome
 * catalogue and the server's `initialize` — and a second read is how two of them
 * end up disagreeing.
 */
export function requestedLocale(): string | undefined {
   const parameters = new URLSearchParams(window.location.search);
   if (parameters.has('locale')) {
      const requested = parameters.get('locale')?.trim();
      return requested === undefined || requested === '' ? undefined : requested;
   }
   const stored = storedPreference('locale')?.trim();
   return stored === undefined || stored === '' ? undefined : stored;
}

/**
 * Remember `locale` for the next visit, English included.
 *
 * English is written as the empty string rather than left unwritten, because
 * choosing it has to OVERWRITE whatever language was stored before. Skipping the
 * write would leave the previous code in place, and the next visit — which
 * carries no parameter, English having none — would read it back and undo the
 * choice.
 */
export function rememberLocale(locale: PageLocale): void {
   rememberPreference('locale', locale.code ?? '');
}

/**
 * Chrome catalogues by language code. Partial by design; a code with no entry
 * here leaves the document's English in place, which is what an adopter with no
 * catalogue for a reader's language also gets.
 */
const CHROME_CATALOGUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
   de: germanChrome
};

/** The catalogue in force: the `data-nls*` overlay reaches markup only, so a
 *  string the page builds at runtime has nothing else to resolve against. */
let activeCatalogue: Readonly<Record<string, string>> | undefined;

/** Translate `key`, falling back to `english` as an unknown locale does. */
export function pageText(key: string, english: string): string {
   return activeCatalogue?.[key] ?? english;
}

/**
 * How each `data-nls*` attribute is applied.
 *
 * A table rather than four blocks, so adding a translatable attribute is a row.
 * `textContent` is the common case and the rest are prose that only reaches a
 * reader through the accessibility tree or a tooltip — which is exactly the
 * prose that gets forgotten, so it is enumerated here rather than left to
 * whoever remembers.
 */
const NLS_TARGETS: readonly { readonly attribute: string; readonly apply: (element: HTMLElement, text: string) => void }[] = [
   { attribute: 'data-nls', apply: (element, text) => (element.textContent = text) },
   { attribute: 'data-nls-title', apply: (element, text) => (element.title = text) },
   { attribute: 'data-nls-placeholder', apply: (element, text) => element.setAttribute('placeholder', text) },
   { attribute: 'data-nls-aria-label', apply: (element, text) => element.setAttribute('aria-label', text) }
];

/**
 * Translate the document's chrome into `locale`, leaving anything the catalogue
 * does not cover as it stands.
 *
 * Called before the heads are started, so the page never paints English and then
 * flips — the same ordering reason `wireSchemeSwitch` is called first.
 */
export function applyPageLocale(locale: string | undefined): void {
   const catalogue = locale === undefined ? undefined : CHROME_CATALOGUES[locale];
   // The document is already in its fallback language, so there is nothing to
   // undo for an unknown code: this returns having changed nothing, which is the
   // correct rendering of "no catalogue for that language".
   if (catalogue === undefined) {
      return;
   }
   activeCatalogue = catalogue;
   document.documentElement.lang = locale ?? 'en';
   for (const target of NLS_TARGETS) {
      for (const element of Array.from(document.querySelectorAll<HTMLElement>(`[${target.attribute}]`))) {
         const translated = catalogue[element.getAttribute(target.attribute) ?? ''];
         if (translated !== undefined) {
            target.apply(element, translated);
         }
      }
   }
}

/**
 * Build the URL that switches the page to `locale`, preserving every other
 * query parameter.
 *
 * Exported for the test tier: the switch's whole behaviour is "which URL does
 * this land on", and asserting that against a function is worth more than
 * asserting it against a navigation.
 */
export function localeUrl(current: string, locale: PageLocale): string {
   const url = new URL(current);
   if (locale.code === undefined) {
      // DELETED rather than set empty. `?locale=` is a URL a reader also reaches
      // by clearing the value by hand, and `requestedLocale` treats it as absent
      // — but leaving it there would make the address bar claim a language the
      // page is not using.
      url.searchParams.delete('locale');
   } else {
      url.searchParams.set('locale', locale.code);
   }
   return url.toString();
}
