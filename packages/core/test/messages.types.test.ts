/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { AstNode, DiagnosticInfo, ValidationAcceptor } from '@hydranium/langium';
import { defineMessage, hasMessageIdentity } from '@hydranium/protocol';
import { describe, expect, it } from 'vitest';
import { acceptMessage } from '../src/messages/carriers.js';

interface Named extends AstNode {
   readonly $type: 'Named';
   name: string;
}

const SEPARATOR = defineMessage('hydranium/core/type-test-separator', "Name '{name}' contains '{separator}'.");
const PLAIN = defineMessage('hydranium/core/type-test-plain', 'Something is wrong.');

const node = { $type: 'Named', name: 'a' } as unknown as Named;

interface Raised {
   readonly severity: string;
   readonly message: string;
   readonly info: DiagnosticInfo<AstNode>;
}

function recordingAcceptor(raised: Raised[]): ValidationAcceptor {
   return (severity, message, info) => {
      raised.push({ severity, message, info: info as DiagnosticInfo<AstNode> });
   };
}

describe('acceptMessage', () => {
   it('writes the code and the identity from one declaration', () => {
      const raised: Raised[] = [];
      acceptMessage(recordingAcceptor(raised), 'error', SEPARATOR, { node, property: 'name' }, { name: 'Foo.Bar', separator: '.' });

      expect(raised).toHaveLength(1);
      expect(raised[0].severity).toBe('error');
      expect(raised[0].message).toBe("Name 'Foo.Bar' contains '.'.");
      // Both, on purpose: `code` is what survives to the editor surface, the
      // envelope is what makes `data` self-describing wherever `data` survives.
      expect(raised[0].info.code).toBe(SEPARATOR.code);
      expect(hasMessageIdentity(raised[0].info.data)).toBe(true);
   });

   it('takes no params argument for a message that has no placeholders', () => {
      const raised: Raised[] = [];
      acceptMessage(recordingAcceptor(raised), 'warning', PLAIN, { node });

      expect(raised[0].message).toBe('Something is wrong.');
      expect(raised[0].info.code).toBe(PLAIN.code);
   });

   it("keeps Langium's own data.code reachable, so a caller can still request a quick fix", () => {
      const raised: Raised[] = [];
      acceptMessage(
         recordingAcceptor(raised),
         'error',
         SEPARATOR,
         { node, data: { code: 'fix-separator' } },
         { name: 'Foo.Bar', separator: '.' }
      );

      // The identity merges OVER the caller's data rather than replacing it, so
      // the two conventions co-exist. Asserting both fields, because `Omit` alone
      // would have silently foreclosed this and an absent field reads as a design
      // choice rather than a regression.
      const data = raised[0].info.data as { code?: string; hydranium?: { code: string } };
      expect(data.code).toBe('fix-separator');
      expect(data.hydranium?.code).toBe(SEPARATOR.code);
   });

   it("carries an adopter's own companion key beside the identity", () => {
      const raised: Raised[] = [];
      // The shape an adopter needs when a diagnostic names WHICH element its own
      // surface must highlight. Langium's `DiagnosticData` is closed, so a narrower
      // `data` type would make the companion and the identity mutually exclusive —
      // and an encoder projecting the companion reads exactly this field.
      acceptMessage(recordingAcceptor(raised), 'warning', PLAIN, { node, data: { code: 'missing-value', ownedByAdopter: 'PropertyOne' } });

      const data = raised[0].info.data as { code?: string; ownedByAdopter?: string; hydranium?: { code: string } };
      expect(data.ownedByAdopter).toBe('PropertyOne');
      expect(data.code).toBe('missing-value');
      expect(data.hydranium?.code).toBe(PLAIN.code);
   });
});

/**
 * The negative half is COMPILE-time only and must never run: `acceptMessage`
 * would accept every one of these at runtime, which is the point — the types are
 * the enforcement, not a runtime check.
 *
 * Exported and never called. `typecheck:test` is what executes it, and that is a
 * separate turbo task from `build`. An unused `@ts-expect-error` is itself an
 * error, so a clean typecheck proves each one fired; the suite controls itself.
 */
export function acceptMessageNegatives(accept: ValidationAcceptor): void {
   // @ts-expect-error `code` is the message's own; a caller cannot set it
   acceptMessage(accept, 'error', SEPARATOR, { node, code: 'mine' }, { name: 'a', separator: '.' });

   // @ts-expect-error a property name that is not on the node
   acceptMessage(accept, 'error', SEPARATOR, { node, property: 'notAProperty' }, { name: 'a', separator: '.' });

   // @ts-expect-error missing params on a message that has placeholders
   acceptMessage(accept, 'error', SEPARATOR, { node });

   // @ts-expect-error params passed to a message that has none
   acceptMessage(accept, 'warning', PLAIN, { node }, { name: 'a' });
}
