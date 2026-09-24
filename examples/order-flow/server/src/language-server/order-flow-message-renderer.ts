/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DefaultMessageRenderer } from '@hydranium/core/messages';
import { MessageCatalogue, type Locale } from '@hydranium/protocol';
import germanCatalogue from '../nls/order-flow.de.json' with { type: 'json' };

/**
 * This example's server-side catalogues, by locale tag.
 *
 * A plain map because the example ships one translation. An adopter with
 * several would load them the same way — the framework never selects a locale,
 * so the only decision here is which map answers the tag it was handed.
 *
 * `_`-prefixed keys are stripped: they document the file for a reader, and a
 * message code is three `/`-separated segments, so a leading `_` can never
 * collide with a real entry. The PREFIX rather than the one literal
 * `_comment`, so a second note added to the JSON does not silently become a
 * catalogue entry — and so this agrees with the flattener the catalogue test
 * uses, which has always keyed off the prefix.
 */
const CATALOGUES: Record<Locale, MessageCatalogue> = {
   de: Object.fromEntries(Object.entries(germanCatalogue).filter(([code]) => !code.startsWith('_')))
};

/**
 * Renders this server's user-facing messages in the locale the client declared
 * at `initialize` — the single binding an adopter with i18n adds, serving the
 * framework's own codes and this example's alike.
 *
 * **This is the whole adopter side of it.** Nothing here selects a locale or
 * inspects a carrier: `translationsFor` is the one override, and the framework
 * keeps the identity handling, the pass-through for a message it has no entry
 * for, and the no-throw contract that stops a bad catalogue key from costing a
 * document its diagnostics.
 *
 * **Matched on the language subtag**, so `de-AT` and `de-CH` get the German
 * entries rather than falling back to English. Which tag a catalogue answers to
 * is an adopter's decision and not a framework default.
 *
 * **A catalogue set carrying regional or script variants needs RFC 4647 Lookup
 * instead**, truncating one subtag at a time from the right so `de-CH` is tried
 * before `de`. Taking the language alone skips every intermediate tag, leaving
 * a `de-CH` catalogue unreachable behind a `de` one; for a script-bearing
 * language it is wrong rather than coarse, `zh-Hant` and `zh-Hans` being no
 * substitute for each other.
 */
export class OrderFlowMessageRenderer extends DefaultMessageRenderer {
   /**
    * The inherited entries first, this example's over them: returning the map
    * alone shadows whatever a base class answers for the same locale, and a
    * shadowed entry renders the English, which no audit can tell from a code
    * nobody translated.
    *
    * Must not throw. The renderer caches this answer per locale only when it
    * returns, so a throw is retried, and logged, for every message rendered.
    */
   protected override translationsFor(locale: Locale | undefined): MessageCatalogue | undefined {
      return MessageCatalogue.merge(super.translationsFor(locale), this.ownCatalogue(locale));
   }

   /**
    * This example's catalogue for `locale`, matched on its language subtag.
    *
    * The tag arrives from a client, and a headless caller's obvious source is
    * an environment variable holding a POSIX spelling such as `de_DE`, which
    * `Intl.Locale` rejects. That is reported once, here, and answered with no
    * catalogue, so the inherited entries and the English still apply.
    */
   protected ownCatalogue(locale: Locale | undefined): MessageCatalogue | undefined {
      if (!locale) {
         return undefined;
      }
      let language: string;
      try {
         language = new Intl.Locale(locale).language;
      } catch (err: unknown) {
         const reason = err instanceof Error ? err.message : String(err);
         this.tracer.warn(`Locale '${locale}' is not a language tag (${reason}); rendering without this server's catalogue`);
         return undefined;
      }
      return CATALOGUES[language];
   }
}
