/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { defineMessage, messageData } from '../src/messages/primitives';

/**
 * The mechanism's guarantees are type-level, so `typecheck:test` is what runs
 * them — a separate turbo task from `build`, which does NOT typecheck tests.
 *
 * Each assertion is a `@ts-expect-error`, and an UNUSED one is itself an error,
 * so a clean compile proves every one of them fired. The suite therefore
 * controls itself: there is no state in which these silently stop discriminating
 * while still reporting green.
 */

const WITH_PARAMS = defineMessage('test/with', "Name '{name}' contains '{separator}'.");
const WITHOUT_PARAMS = defineMessage('test/without', 'Nothing to substitute.');

const name = 'Foo.Bar';
const separator = '.';

describe('the type-level guarantees', () => {
   it('compiles, which is the assertion', () => {
      // Accepted: exactly the declared placeholders, and no argument when there are none.
      expect(WITH_PARAMS.format({ name, separator })).toBeTypeOf('string');
      expect(WITHOUT_PARAMS.format()).toBeTypeOf('string');

      // @ts-expect-error a message with placeholders requires its params
      WITH_PARAMS.format();

      // @ts-expect-error a message without placeholders accepts none
      WITHOUT_PARAMS.format({ nope: 1 });

      // @ts-expect-error every declared placeholder is required
      WITH_PARAMS.format({ name });

      // @ts-expect-error a misspelled placeholder is not a valid key
      WITH_PARAMS.format({ name, seperator: separator });

      // @ts-expect-error messageData carries the same arity rule as format
      messageData(WITH_PARAMS);
   });
});

describe('LiteralText closes the widened-text hole', () => {
   it('compiles, which is the assertion', () => {
      const widened: string = 'Hello {name}';

      // @ts-expect-error a text already widened to `string` infers no placeholders, so it is rejected outright
      defineMessage('test/widened', widened);

      // @ts-expect-error a concatenation is widened for the same reason
      defineMessage('test/concatenated', 'Name ' + "'{name}'" + ' is reserved.');

      // A template literal interpolating a string still carries its own literal
      // placeholders, so this is accepted and correctly requires `{code}`.
      const detail = 'boom';
      const templated = defineMessage('test/templated', `Could not connect: ${detail} {code}`);
      expect(templated.format({ code: 7 })).toContain('7');
   });
});
