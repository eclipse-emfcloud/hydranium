/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { collectMessages, renderFrameworkMessage, resolve, TransferDiagnostic } from '@hydranium/protocol';
import * as protocolMessages from '@hydranium/protocol/lib/messages';
import { DATA_SERVER_CONNECT_FAILED } from '@hydranium/protocol/lib/messages';
import * as coreMessages from '@hydranium/core/lib/messages';
import * as orderFlowMessages from '@hydranium/example-order-flow-client/lib/properties/properties-messages';
import * as orderFlowServerMessages from '@hydranium/example-order-flow-server/lib/messages';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the German catalogue against the one way it rots silently: a key that
 * names no real code.
 *
 * Nothing else can catch it. Theia looks a key up and falls back to the English
 * when it misses, which is the behaviour an adopter wants and also means a typo
 * is indistinguishable from a deliberate omission at runtime. `nls-extract` does
 * not help either — it reports what the SOURCE declares, not whether a catalogue
 * matches it.
 */

const CATALOGUE = path.join(__dirname, '..', 'src', 'nls', 'order-flow.de.json');
/**
 * The whole tree, not the one file that happens to hold every host-bound key
 * today. Scoping this to a single source encodes an assumption nothing states
 * and nothing enforces, and it fails in the confusing direction: a key declared
 * in a SECOND file and translated here would be reported as naming no real key,
 * which reads as a typo in the catalogue rather than as a stale test.
 */
const HOST_SOURCE_ROOT = path.join(__dirname, '..', '..', '..', '..', 'packages', 'client-theia', 'src');

function readHostSources(): { text: string; fileCount: number } {
   const files = readdirSync(HOST_SOURCE_ROOT, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
      .map(entry => path.join(entry.parentPath, entry.name));
   return { text: files.map(file => readFileSync(file, 'utf-8')).join('\n'), fileCount: files.length };
}

/** Theia joins nested catalogue keys with `/`, which is what the codes use. */
function flatten(node: Record<string, unknown>, prefix = ''): Record<string, string> {
   const flat: Record<string, string> = {};
   for (const [key, value] of Object.entries(node)) {
      // A `_`-prefixed key is a note to a human reader, not a translation.
      if (key.startsWith('_')) {
         continue;
      }
      const joined = prefix ? `${prefix}/${key}` : key;
      if (typeof value === 'string') {
         flat[joined] = value;
      } else if (typeof value === 'object' && value !== null) {
         Object.assign(flat, flatten(value as Record<string, unknown>, joined));
      }
   }
   return flat;
}

const translations = flatten(JSON.parse(readFileSync(CATALOGUE, 'utf-8')) as Record<string, unknown>);

describe('the German catalogue', () => {
   it('is not empty, so a broken read cannot pass every case below vacuously', () => {
      expect(Object.keys(translations).length).toBeGreaterThan(10);
   });

   it('names a real code for every identity-side and adopter-owned key', () => {
      const declared = new Set(
         [protocolMessages, coreMessages, orderFlowMessages, orderFlowServerMessages].flatMap(barrel =>
            collectMessages(barrel).map(message => message.code)
         )
      );
      // Every key EXCEPT the host-bound ones, which are inline literals with no
      // barrel to enumerate and are checked against the source below. Nothing
      // else is exempt: exempting a namespace here would let a typo in it pass.
      const orphans = Object.keys(translations).filter(key => !key.startsWith('hydranium/client-theia/') && !declared.has(key));
      expect(orphans).toEqual([]);
   });

   it('names a real key for every host-bound entry', () => {
      // The host layer's keys are inline literals inside `nls.localize`, so the
      // source is the only place they exist — matched textually here for the same
      // reason the extractor does it textually.
      const { text, fileCount } = readHostSources();
      // A glob that has stopped matching would make every assertion below pass
      // against an empty string, which is the failure a widened scan invites and
      // the reason the count is asserted rather than assumed.
      expect(fileCount).toBeGreaterThan(1);
      const hostKeys = Object.keys(translations).filter(key => key.startsWith('hydranium/client-theia/'));
      expect(hostKeys.length).toBeGreaterThan(0);
      expect(hostKeys.filter(key => !text.includes(`'${key}'`))).toEqual([]);
   });

   it('renders a framework message into German through the host-neutral helper', () => {
      // The whole point of the mechanism: the framework attaches an identity and
      // never translates, and this side — which knows the locale — renders it.
      const reported = resolve(DATA_SERVER_CONNECT_FAILED, { detail: 'ECONNREFUSED' });

      expect(renderFrameworkMessage(reported, translations)).toBe('Verbindung zum Datenserver fehlgeschlagen: ECONNREFUSED');
      // And an adopter with no catalogue at all still gets a complete sentence.
      expect(renderFrameworkMessage(reported)).toBe('Could not connect to the data server: ECONNREFUSED');
   });

   it('renders the parameterised validation diagnostic with no placeholder left standing', () => {
      // The entry that could not work until `TransferDiagnostic` carried
      // `params`, and the reason its absence was invisible: substitution leaves
      // an unmatched token in place rather than raising, so a half-carried
      // identity renders a German sentence with a literal `{name}` in it and
      // nothing anywhere reports a fault.
      const diagnostic: TransferDiagnostic = {
         type: 'validation-error',
         element: '/root@0',
         message: coreMessages.SEPARATOR_IN_NAME.format({ name: 'Order.Line', separator: '.' }),
         severity: 'error',
         code: coreMessages.SEPARATOR_IN_NAME.code,
         params: { name: 'Order.Line', separator: '.' }
      };

      const rendered = renderFrameworkMessage(TransferDiagnostic.resolved(diagnostic)!, translations);

      expect(rendered).toContain("'Order.Line'");
      expect(rendered).toContain("'.'");
      expect(rendered).not.toMatch(/\{[^}]+\}/);
      // Not merely "some German": the assertion above passes for the English too.
      expect(rendered).toContain('Namenstrennzeichen');
   });

   it('falls back to English for a code it deliberately does not carry', () => {
      // The catalogue is partial on purpose, so this is the majority case rather
      // than an edge one. It is also why a typo cannot be caught at runtime.
      const untranslated = resolve(coreMessages.NO_LOADABLE_CONTENT, { uri: 'file:///a.of' });
      expect(renderFrameworkMessage(untranslated, translations)).toBe('No loadable content for file:///a.of');
   });
});
