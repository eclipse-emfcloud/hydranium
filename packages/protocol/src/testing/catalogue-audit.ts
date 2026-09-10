/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { collectMessages } from '../messages/primitives';

/**
 * Audit a translation catalogue against the codes that actually exist.
 *
 * **The one failure mode a catalogue has, and the only one nothing else
 * catches.** A key naming no declared code falls back to the English — which is
 * byte-identical to a deliberate omission, so a typo is invisible at runtime and
 * indistinguishable from the partial-catalogue behaviour every adopter relies
 * on. Nothing on the render path can tell them apart, `theia nls-extract`
 * reports what the SOURCE declares rather than whether a catalogue matches it,
 * and the framework's own gates see only the framework's own files.
 *
 * Shipped as test support rather than as a runtime check on purpose: an
 * orphaned key is an authoring mistake, and failing a server boot over one would
 * take a running product down for a cosmetic defect.
 */

/**
 * Flatten a nested catalogue into the `/`-joined keys a message code is spelled
 * with, dropping `_`-prefixed keys as notes to a human reader.
 *
 * Nesting is a HOST convention, not the framework's: Theia flattens a nested
 * catalogue by joining keys with `/`, which is the separator a code already
 * uses, so an adopter on that host writes the file nested and one handed
 * straight to a `ServerMessageRenderer` writes it flat. Both end up here.
 *
 * `_`-prefixed keys are dropped by PREFIX rather than by matching one literal
 * name, so a second note added to a file cannot silently become a catalogue
 * entry. A code is three `/`-separated segments, so no real entry can begin
 * with `_`.
 */
export function flattenCatalogue(catalogue: Record<string, unknown>, prefix = ''): Record<string, string> {
   const flat: Record<string, string> = {};
   for (const [key, value] of Object.entries(catalogue)) {
      if (key.startsWith('_')) {
         continue;
      }
      const joined = prefix ? `${prefix}/${key}` : key;
      if (typeof value === 'string') {
         flat[joined] = value;
      } else if (typeof value === 'object' && value !== null) {
         Object.assign(flat, flattenCatalogue(value as Record<string, unknown>, joined));
      }
   }
   return flat;
}

/** Options for {@link findUndeclaredCodes}. */
export interface CatalogueAuditOptions {
   /**
    * Key prefixes to skip, for entries whose codes are NOT declared through a
    * `defineMessage` barrel.
    *
    * The real case is a host's own mechanism: Theia's `nls.localize` takes its
    * key as an inline literal at the call site, so those keys exist only in
    * source text and no barrel can enumerate them. Keep this as narrow as the
    * host layer actually is — exempting a namespace is exempting every typo in
    * it, which is what this function exists to find.
    */
   readonly exemptPrefixes?: readonly string[];
}

/**
 * Every catalogue key that names no code any of `barrels` declares.
 *
 * Barrels are taken as opaque objects and read with {@link collectMessages},
 * which is what lets a caller pass a `import * as messages` namespace directly:
 * a barrel's value type is a union of its declarations AND its functions, and
 * filtering that union will not narrow to a `MessageDefinition`.
 *
 * Returns the offending keys rather than a boolean, so a failing assertion names
 * WHICH key is wrong — a count says only that something is.
 */
export function findUndeclaredCodes(
   catalogueKeys: readonly string[],
   barrels: readonly object[],
   options: CatalogueAuditOptions = {}
): string[] {
   const declared = new Set(barrels.flatMap(barrel => collectMessages(barrel).map(message => message.code)));
   const exempt = options.exemptPrefixes ?? [];
   return catalogueKeys.filter(key => !exempt.some(prefix => key.startsWith(prefix)) && !declared.has(key));
}

/**
 * Keys present in more than one catalogue — the shape a split catalogue rots
 * into.
 *
 * Exactly one side renders a given message, so two catalogues holding one code
 * are two authorities over one sentence and they diverge on the first reword.
 * Nothing at runtime notices: both sides render, and whichever ran last wins on
 * its own surface.
 *
 * Takes the key sets rather than a boolean answer for the same reason as
 * {@link findUndeclaredCodes}, and reports NOTHING when a set is empty — an
 * empty catalogue shares no key with anything, so a caller must assert
 * non-emptiness separately or a failed read passes this vacuously.
 */
export function findSharedCodes(first: readonly string[], second: readonly string[]): string[] {
   const other = new Set(second);
   return first.filter(key => other.has(key));
}
