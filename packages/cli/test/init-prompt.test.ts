/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `@clack/prompts` adapter, against a stubbed library.
 *
 * The sibling wizard tests drive a scripted {@link PromptPort} and so never
 * execute this file — which leaves the translation between the two vocabularies
 * (our `choices` vs clack's `options`, the cancel SENTINEL vs an exception)
 * as the one part of the interactive path nothing covers. A typo there surfaces
 * only when a person runs the wizard.
 *
 * The library is stubbed rather than driven, deliberately: clack reads
 * keypresses from a real TTY and will not settle on a pipe, so driving it for
 * real needs a pseudo-terminal. What is worth pinning here is the mapping, not
 * clack's rendering — so the stub records what it was ASKED, and the assertions
 * are about that.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** What the stubbed clack was called with, per prompt kind. */
const calls: Record<string, Array<Record<string, unknown>>> = {};

/** The value the next stubbed prompt resolves with — a cancel symbol when testing that path. */
let nextAnswer: unknown = '';

const CANCEL = Symbol('clack:cancel');

vi.mock('@clack/prompts', () => {
   const record = (kind: string) => (options: Record<string, unknown>) => {
      (calls[kind] ??= []).push(options);
      return Promise.resolve(nextAnswer);
   };
   return {
      text: record('text'),
      select: record('select'),
      multiselect: record('multiselect'),
      confirm: record('confirm'),
      intro: vi.fn(),
      note: vi.fn(),
      outro: vi.fn(),
      isCancel: (value: unknown) => value === CANCEL
   };
});

const { createClackPrompt, InitWizardCancelled, OPTIONAL_HEAD_CHOICES } = await import('../src/commands/init-prompt.js');

describe('the clack adapter', () => {
   beforeEach(() => {
      for (const key of Object.keys(calls)) {
         delete calls[key];
      }
      nextAnswer = '';
   });

   it('passes the default through and trims what comes back', async () => {
      const prompt = await createClackPrompt();
      nextAnswer = '  OrderFlow  ';
      const answer = await prompt.text({ message: 'Project name', initialValue: 'Bookstore' });

      expect(answer).toBe('OrderFlow');
      expect(calls.text[0]).toMatchObject({ message: 'Project name', initialValue: 'Bookstore' });
   });

   /**
    * Our `validate` returns a message or `undefined`; clack's takes the raw
    * value, which may be undefined on an empty line. Trimming and the
    * undefined-guard both live in the adapter, so both are pinned here.
    */
   it('adapts the validator, tolerating an empty answer', async () => {
      const prompt = await createClackPrompt();
      nextAnswer = 'x';
      await prompt.text({ message: 'Extension', validate: value => (value === '' ? 'required' : undefined) });

      const validate = calls.text[0].validate as (value?: string) => string | undefined;
      expect(validate('  book  ')).toBeUndefined();
      expect(validate(undefined)).toBe('required');
   });

   it('renames choices to options and keeps the hints', async () => {
      const prompt = await createClackPrompt();
      nextAnswer = 'data';
      await prompt.select({ message: 'Pick', choices: [{ value: 'data', label: 'data', hint: 'why' }], initialValue: 'data' });

      expect(calls.select[0]).toMatchObject({
         message: 'Pick',
         initialValue: 'data',
         options: [{ value: 'data', label: 'data', hint: 'why' }]
      });
   });

   it('omits an absent hint rather than passing undefined', async () => {
      const prompt = await createClackPrompt();
      nextAnswer = 'a';
      await prompt.select({ message: 'Pick', choices: [{ value: 'a', label: 'A' }] });

      expect(Object.keys((calls.select[0].options as object[])[0])).toEqual(['value', 'label']);
   });

   /**
    * An `lsp`-only project is legal — a plain LSP server with no other head —
    * so the head checkbox must accept an empty selection.
    */
   it('lets the head multiselect come back empty', async () => {
      const prompt = await createClackPrompt();
      nextAnswer = [];
      const answer = await prompt.multiselect({ message: 'Heads', choices: OPTIONAL_HEAD_CHOICES, initialValues: ['data'] });

      expect(answer).toEqual([]);
      expect(calls.multiselect[0]).toMatchObject({ required: false, initialValues: ['data'] });
   });

   it('turns the cancel sentinel into a throw, on every prompt kind', async () => {
      const prompt = await createClackPrompt();
      nextAnswer = CANCEL;

      await expect(prompt.text({ message: 'Name' })).rejects.toThrow(InitWizardCancelled);
      await expect(prompt.select({ message: 'Pick', choices: [{ value: 'a', label: 'A' }] })).rejects.toThrow(InitWizardCancelled);
      await expect(prompt.multiselect({ message: 'Heads', choices: [] })).rejects.toThrow(InitWizardCancelled);
      await expect(prompt.confirm({ message: 'Sure?' })).rejects.toThrow(InitWizardCancelled);
   });
});
