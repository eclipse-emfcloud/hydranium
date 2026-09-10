/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ResponseError } from 'vscode-jsonrpc';
import { describe, expect, it } from 'vitest';
import {
   collectMessages,
   defineMessage,
   describeError,
   hasMessageIdentity,
   interpolate,
   isMessageDeclaration,
   messageData,
   messageError,
   renderFrameworkMessage,
   resolve,
   resolvedFromResponseError
} from '../src/messages/primitives';
import * as protocolMessages from '../src/messages/index';

const WITH_PARAMS = defineMessage('test/with', "Name '{name}' contains '{separator}'.");
const WITHOUT_PARAMS = defineMessage('test/without', 'Nothing to substitute.');

describe('defineMessage', () => {
   it('infers placeholder names from the text and substitutes them', () => {
      expect(WITH_PARAMS.format({ name: 'Foo.Bar', separator: '.' })).toBe("Name 'Foo.Bar' contains '.'.");
   });

   it('takes no argument when the text has no placeholders', () => {
      expect(WITHOUT_PARAMS.format()).toBe('Nothing to substitute.');
   });

   it('carries the code and the English text as data', () => {
      expect(WITH_PARAMS.code).toBe('test/with');
      expect(WITHOUT_PARAMS.text).toBe('Nothing to substitute.');
   });
});

describe('interpolate never throws', () => {
   // Every case here crashed some earlier form of the substitution, and the
   // brace-bearing value is the one a normal fixture never produces.
   it('passes a parameter value that itself looks like a placeholder through untouched', () => {
      expect(WITH_PARAMS.format({ name: '{separator}', separator: '.' })).toBe("Name '{separator}' contains '.'.");
   });

   it('leaves an unfilled token in place rather than raising', () => {
      expect(interpolate('{a}{b}', { a: 1 })).toBe('1{b}');
   });

   it('degrades on inputs no caller should produce', () => {
      expect(interpolate('{unclosed', {})).toBe('{unclosed');
      expect(interpolate('{}', {})).toBe('{}');
      expect(interpolate('', {})).toBe('');
   });

   it('survives params being absent entirely, which is what a version skew produces', () => {
      const noParams = undefined as unknown as Record<string, string>;
      expect(interpolate('a {x} b', noParams)).toBe('a {x} b');
   });
});

describe('hasMessageIdentity', () => {
   it('accepts a well-formed envelope', () => {
      expect(hasMessageIdentity(messageData(WITH_PARAMS, { name: 'n', separator: '.' }))).toBe(true);
   });

   it('rejects an envelope whose params are missing', () => {
      // The partial-guard defect: invisible in English, crashing only once a
      // translation is loaded, i.e. only for the adopters this exists for.
      expect(hasMessageIdentity({ hydranium: { code: 'test/with' } })).toBe(false);
   });

   it("rejects a foreign data convention, including Langium's own", () => {
      expect(hasMessageIdentity({ code: 'lexing-error' })).toBe(false);
      expect(hasMessageIdentity(undefined)).toBe(false);
      expect(hasMessageIdentity(null)).toBe(false);
   });

   it('rejects an array that carries a hydranium property', () => {
      const arrayWithProperty = Object.assign([], { hydranium: { code: 'x', params: {} } });
      expect(hasMessageIdentity(arrayWithProperty)).toBe(false);
   });
});

describe('renderFrameworkMessage', () => {
   const reported = resolve(WITH_PARAMS, { name: 'Foo.Bar', separator: '.' });

   it('yields the English when no translation map is passed', () => {
      expect(renderFrameworkMessage(reported)).toBe("Name 'Foo.Bar' contains '.'.");
   });

   it('renders a translation whose placeholders are reordered', () => {
      const german = { 'test/with': "'{separator}' steckt in '{name}'." };
      expect(renderFrameworkMessage(reported, german)).toBe("'.' steckt in 'Foo.Bar'.");
   });

   it('leaves a misspelled placeholder in a translation and renders the rest', () => {
      const typo = { 'test/with': "Name '{nmae}' contains '{separator}'." };
      expect(renderFrameworkMessage(reported, typo)).toBe("Name '{nmae}' contains '.'.");
   });

   it('falls back to the English for a code the map does not carry', () => {
      expect(renderFrameworkMessage(reported, { 'test/other': 'unrelated' })).toBe("Name 'Foo.Bar' contains '.'.");
   });
});

describe('messageError', () => {
   it('survives a real JSON round trip with its identity intact', () => {
      const error = messageError(1234, WITH_PARAMS, { name: 'Foo.Bar', separator: '.' });
      // Asserting on the reconstructed shape, not the instance: after a hop the
      // class is gone, so an in-process assertion would pass with the envelope absent.
      const wire = JSON.parse(JSON.stringify(error.toJson())) as { code: number; message: string; data: unknown };

      expect(wire.code).toBe(1234);
      expect(wire.message).toBe("Name 'Foo.Bar' contains '.'.");
      expect(hasMessageIdentity(wire.data)).toBe(true);

      const recovered = resolvedFromResponseError(new ResponseError(wire.code, wire.message, wire.data));
      expect(recovered?.code).toBe('test/with');
      expect(recovered?.params).toEqual({ name: 'Foo.Bar', separator: '.' });
   });

   it('yields no identity for an error that carries none', () => {
      expect(resolvedFromResponseError(new ResponseError(1, 'plain'))).toBeUndefined();
   });
});

describe('describeError', () => {
   it('prefers an Error message and stringifies anything else', () => {
      expect(describeError(new Error('boom'))).toBe('boom');
      expect(describeError('boom')).toBe('boom');
      expect(describeError(undefined)).toBe('undefined');
   });
});

describe('isMessageDeclaration', () => {
   it('rejects a code/text pair with no format function', () => {
      // Load-bearing: a `{ code, text }` test alone admits this decoy, and an
      // adopter emitting a catalogue would ship it as a message.
      expect(isMessageDeclaration({ code: 'test/decoy', text: 'not a declaration' })).toBe(false);
      expect(isMessageDeclaration(WITH_PARAMS)).toBe(true);
      expect(isMessageDeclaration(() => undefined)).toBe(false);
   });
});

describe("the protocol barrel's codes", () => {
   // The ONLY enforcement of the namespace convention: lint cannot see a key's
   // shape, and per-package declaration means nothing else checks uniqueness.
   const codes = collectMessages(protocolMessages).map(declaration => declaration.code);

   it('enumerates every declaration the package raises', () => {
      expect(codes.length).toBeGreaterThan(0);
   });

   it('prefixes every code with this package', () => {
      expect(codes.filter(code => !code.startsWith('hydranium/protocol/'))).toEqual([]);
   });

   it('has no duplicate code', () => {
      expect(new Set(codes).size).toBe(codes.length);
   });

   it('has no code that is a prefix of another', () => {
      // Hard-required rather than insurance: a host catalogue is nested JSON and
      // errors outright when one key is a prefix of another.
      const prefixed = codes.filter(code => codes.some(other => other !== code && other.startsWith(code)));
      expect(prefixed).toEqual([]);
   });
});
