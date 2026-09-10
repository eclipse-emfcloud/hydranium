/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { renderFrameworkMessage, resolve } from '@hydranium/protocol';
// The `./lib/testing` twin, not the short `./testing` specifier: this package
// resolves with `moduleResolution: "Node"`, which reaches no `exports` subpath —
// the same reason the message barrels below are spelled `/lib/messages`.
import { findSharedCodes, findUndeclaredCodes, flattenCatalogue } from '@hydranium/protocol/lib/testing';
import * as protocolMessages from '@hydranium/protocol/lib/messages';
import { DATA_SERVER_CONNECT_FAILED } from '@hydranium/protocol/lib/messages';
import * as coreMessages from '@hydranium/core/lib/messages';
import * as glspServerMessages from '@hydranium/glsp-server/lib/messages';
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

/** Read a catalogue file and flatten it to the `/`-joined keys a code is spelled with. */
function readCatalogue(file: string): Record<string, string> {
   return flattenCatalogue(JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>);
}

const translations = readCatalogue(CATALOGUE);

/**
 * The catalogue the SERVER renders from. Flat already — it is handed straight to
 * the framework's renderer, with no Theia flattening in between — so it goes
 * through the same helper only to drop the `_comment` note.
 */
const SERVER_CATALOGUE = path.join(__dirname, '..', '..', 'server', 'src', 'nls', 'order-flow.de.json');
const serverTranslations = readCatalogue(SERVER_CATALOGUE);

/**
 * Every barrel a key here may name. Passed to the framework's audit rather than
 * unioned by hand: `collectMessages` is what discriminates a declaration from a
 * barrel's other exports, and a hand-rolled union over `Object.values` does not
 * narrow.
 */
const BARRELS = [protocolMessages, coreMessages, glspServerMessages, orderFlowMessages, orderFlowServerMessages];

/**
 * The one exemption, and it has to be exactly this narrow.
 *
 * `hydranium/client-theia/*` keys are inline literals inside `nls.localize`, so
 * no barrel can enumerate them — they are checked against the SOURCE below
 * instead. Exempting any wider namespace would exempt every typo in it, which is
 * what the audit exists to find.
 */
const HOST_BOUND_PREFIX = 'hydranium/client-theia/';

describe('the German catalogue', () => {
   it('is not empty, so a broken read cannot pass every case below vacuously', () => {
      expect(Object.keys(translations).length).toBeGreaterThan(10);
   });

   it('names a real code for every identity-side and adopter-owned key', () => {
      // The framework's own audit rather than a local union, so an adopter
      // copying this file copies a supported helper and not fifteen lines of
      // set arithmetic. What stays local is the two decisions only this project
      // can make: which barrels, and which prefix is exempt.
      expect(findUndeclaredCodes(Object.keys(translations), BARRELS, { exemptPrefixes: [HOST_BOUND_PREFIX] })).toEqual([]);

      // The server catalogue over the same barrels, with NO exemption: nothing
      // there resolves through `nls.localize`, so every key is checkable.
      expect(findUndeclaredCodes(Object.keys(serverTranslations), BARRELS)).toEqual([]);
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
      // The same prefix the audit above exempts, so the exemption and this check
      // cannot drift apart into a namespace nothing verifies.
      const hostKeys = Object.keys(translations).filter(key => key.startsWith(HOST_BOUND_PREFIX));
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

   it('shares no key with the catalogue the SERVER renders from', () => {
      // The invariant, made checkable: a message rendered on both sides has two
      // authorities over one sentence, and the two would drift on the first
      // reword. Which side renders a message decides which file it belongs in,
      // so an overlap is the defect — not a duplicate translation.
      const serverKeys = Object.keys(serverTranslations);
      // Both non-empty first, which `findSharedCodes` documents as the caller's
      // job: an empty set on either side satisfies a disjointness assertion
      // while proving nothing, and empty is the shape a failed read takes.
      expect(serverKeys.length).toBeGreaterThan(0);
      expect(Object.keys(translations).length).toBeGreaterThan(0);

      expect(findSharedCodes(serverKeys, Object.keys(translations))).toEqual([]);
   });

   it('leaves every server-rendered code to the server, including the ones it used to hold', () => {
      // Named explicitly rather than left to the disjointness check, because
      // these two MOVED: both were rendered on this side before the server
      // rendered its own messages, and a merge that reinstated either would
      // still pass a disjointness test if the server's copy were dropped in the
      // same edit.
      expect(translations).not.toHaveProperty(coreMessages.SEPARATOR_IN_NAME.code);
      expect(translations).not.toHaveProperty(orderFlowServerMessages.SELF_TRANSITION.code);
      expect(serverTranslations).toHaveProperty(coreMessages.SEPARATOR_IN_NAME.code);
      expect(serverTranslations).toHaveProperty(orderFlowServerMessages.SELF_TRANSITION.code);
   });

   it('falls back to English for a code it deliberately does not carry', () => {
      // The catalogue is partial on purpose, so this is the majority case rather
      // than an edge one. It is also why a typo cannot be caught at runtime.
      const untranslated = resolve(coreMessages.NO_LOADABLE_CONTENT, { uri: 'file:///a.of' });
      expect(renderFrameworkMessage(untranslated, translations)).toBe('No loadable content for file:///a.of');
   });
});
