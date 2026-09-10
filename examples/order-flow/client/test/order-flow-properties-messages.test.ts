/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The adopter's side of the message-externalization contract.
 *
 * An adopter that declares messages inherits the same two obligations the
 * framework holds itself to, and this suite is the shape to copy: keep out of
 * the reserved namespace, and keep the keyspace flat and unique. Neither is
 * visible to lint or to the compiler — a code is just a string — so a test is
 * the only enforcement there is.
 */

import { isMessageDeclaration, renderFrameworkMessage, resolve } from '@hydranium/protocol';
import { describe, expect, it } from 'vitest';
import * as propertiesMessages from '../src/properties/properties-messages';
import { PROPERTIES_OPEN_FAILED, PROPERTIES_WRITE_FAILED } from '../src/properties/properties-messages';

const codes = Object.values(propertiesMessages)
   .filter(isMessageDeclaration)
   .map(declaration => declaration.code);

describe("the properties panel's message codes", () => {
   it('enumerates every declaration the module holds', () => {
      // Without this the three assertions below are all vacuously true of an
      // empty list, which is what a renamed or moved module would produce.
      expect(codes.length).toBeGreaterThan(0);
   });

   it('stays out of the framework-reserved namespace', () => {
      // `hydranium/` belongs to the framework, whose own per-package tests
      // assert that every code in one of its barrels names the package it is
      // declared in. An adopter code in that namespace puts two owners in one
      // keyspace, where a rename on either side silently shadows the other's
      // catalogue entry.
      expect(codes.filter(code => code.startsWith('hydranium/'))).toEqual([]);
   });

   it("prefixes every code with the adopter's own name", () => {
      expect(codes.filter(code => !/^order-flow\/[a-z0-9-]+\/[a-z0-9-]+$/.test(code))).toEqual([]);
   });

   it('has no duplicate code and none that is a prefix of another', () => {
      // A host catalogue is nested JSON, which errors outright when one key is
      // a prefix of another — so this is a hard requirement, not insurance.
      expect(new Set(codes).size).toBe(codes.length);
      expect(codes.filter(code => codes.some(other => other !== code && other.startsWith(code)))).toEqual([]);
   });
});

describe("the properties panel's message texts", () => {
   it('resolves to a complete sentence with the detail interpolated', () => {
      // The whole point of the seam: the sentence leaves the raise site already
      // finished, so no host has to compose one around a fragment.
      const reported = resolve(PROPERTIES_OPEN_FAILED, { uri: 'file:///a.process', detail: 'connection refused' });

      expect(reported.text).toBe('Order Flow properties: could not open file:///a.process. connection refused');
      expect(renderFrameworkMessage(reported)).toBe(reported.text);
   });

   it('carries its parameters so a translation can reorder them', () => {
      // A renderer given a catalogue reads the sentence out of `params`, not out
      // of `text` — a message that arrived with its parameters dropped would
      // render correctly in English and lose the detail in every other language.
      const reported = resolve(PROPERTIES_WRITE_FAILED, { field: 'name', detail: 'stale baseVersion' });
      const catalogue = { [PROPERTIES_WRITE_FAILED.code]: "{detail} — '{field}' wurde nicht gespeichert." };

      expect(reported.params).toEqual({ field: 'name', detail: 'stale baseVersion' });
      expect(renderFrameworkMessage(reported, catalogue)).toBe("stale baseVersion — 'name' wurde nicht gespeichert.");
   });
});
