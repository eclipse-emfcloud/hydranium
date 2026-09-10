/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DefaultMessageRenderer } from '@hydranium/core/messages';
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
const CATALOGUES: Record<string, Record<string, string>> = {
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
 * **Matched on the primary subtag**, so `de-AT` and `de-CH` get the German
 * entries rather than falling back to English. That is a decision an adopter
 * owns, not a framework default — a language whose regional variants differ in
 * substance would key on the full tag instead.
 */
export class OrderFlowMessageRenderer extends DefaultMessageRenderer {
   protected override translationsFor(locale: string | undefined): Record<string, string> | undefined {
      return locale ? CATALOGUES[locale.split('-')[0].toLowerCase()] : undefined;
   }
}
