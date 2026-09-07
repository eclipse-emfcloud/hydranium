/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The wizard's question/answer port, and its `@clack/prompts` implementation.
 *
 * Semantic rather than line-oriented — `text` / `select` / `multiselect` /
 * `confirm` instead of one `ask(string)` — for two reasons. It lets the real
 * implementation render arrow-key lists and checkboxes, which a readline loop
 * cannot; and it keeps the flow in `runInitWizard` testable against a
 * scripted port, so the wizard's logic is exercised without a TTY, without
 * ANSI parsing, and without the prompt library in the assertion path.
 *
 * Cancellation is an exception rather than a sentinel value: clack signals
 * Ctrl-C by RETURNING a cancel symbol, so a caller that forgets to check it
 * carries on with a symbol where a string should be. Throwing puts the check in
 * one place and makes forgetting it impossible.
 */

// Type-only, so it is erased at compile time and the dynamic `import()` in
// `createClackPrompt` stays the only thing that actually loads the library.
import type { Option as ClackOption } from '@clack/prompts';
import type { InitHead } from './init.js';

/** One choice in a {@link PromptPort.select} or {@link PromptPort.multiselect} list. */
export interface PromptChoice<Value extends string> {
   readonly value: Value;
   readonly label: string;
   /** Dimmed trailing text, for the rule or consequence behind the choice. */
   readonly hint?: string;
}

/** A free-text question. `validate` returns a message to re-ask with, or `undefined` to accept. */
export interface PromptTextOptions {
   readonly message: string;
   readonly initialValue?: string;
   readonly placeholder?: string;
   readonly validate?: (value: string) => string | undefined;
}

/** Thrown when the user cancels — Ctrl-C, or an EOF on the input stream. */
export class InitWizardCancelled extends Error {
   constructor() {
      super('Scaffolding cancelled.');
      this.name = 'InitWizardCancelled';
   }
}

/** The prompts the wizard needs, and nothing more. */
export interface PromptPort {
   /** Open the session with a title. */
   readonly intro: (title: string) => void;
   /** Show a block of context that is not a question. */
   readonly note: (message: string, title?: string) => void;
   /** Ask for a line of text. */
   readonly text: (options: PromptTextOptions) => Promise<string>;
   /** Ask for exactly one of several choices. */
   readonly select: <Value extends string>(options: {
      readonly message: string;
      readonly choices: ReadonlyArray<PromptChoice<Value>>;
      readonly initialValue?: Value;
   }) => Promise<Value>;
   /** Ask for any number of several choices, including none. */
   readonly multiselect: <Value extends string>(options: {
      readonly message: string;
      readonly choices: ReadonlyArray<PromptChoice<Value>>;
      readonly initialValues?: readonly Value[];
   }) => Promise<Value[]>;
   /** Ask a yes/no question. */
   readonly confirm: (options: { readonly message: string; readonly initialValue?: boolean }) => Promise<boolean>;
   /** Close the session with a closing line. */
   readonly outro: (message: string) => void;
}

/** The optional heads, as a checkbox list. `lsp` is not offered — see `askHeads`. */
export const OPTIONAL_HEAD_CHOICES: ReadonlyArray<PromptChoice<Exclude<InitHead, 'lsp'>>> = [
   { value: 'data', label: 'data', hint: 'typed JSON-RPC for forms, trees and code-gen' },
   { value: 'glsp', label: 'glsp', hint: 'graphical editing; adds a scaffolded diagram' }
];

/**
 * The real prompt, backed by `@clack/prompts`.
 *
 * Imported dynamically so the library loads only when someone actually reaches
 * the interactive path: every non-interactive `init`, and all twelve other
 * subcommands, keep their previous startup cost.
 */
export async function createClackPrompt(): Promise<PromptPort> {
   const clack = await import('@clack/prompts');

   /** Unwrap a clack answer, turning its cancel sentinel into a throw. */
   const unwrap = <Value>(answer: Value | symbol): Value => {
      if (clack.isCancel(answer)) {
         throw new InitWizardCancelled();
      }
      return answer;
   };

   // `Option<Value>` is a conditional type over the value, which stays deferred
   // under our own generic parameter and so refuses a structurally identical
   // literal. The cast asserts the shape the branch resolves to for `string`.
   const toOptions = <Value extends string>(choices: ReadonlyArray<PromptChoice<Value>>): Array<ClackOption<Value>> =>
      choices.map(choice => ({
         value: choice.value,
         label: choice.label,
         ...(choice.hint === undefined ? {} : { hint: choice.hint })
      })) as Array<ClackOption<Value>>;

   return {
      intro: title => clack.intro(title),
      note: (message, title) => clack.note(message, title),
      text: async options =>
         unwrap(
            await clack.text({
               message: options.message,
               initialValue: options.initialValue,
               placeholder: options.placeholder,
               validate: value => options.validate?.((value ?? '').trim())
            })
         ).trim(),
      select: async options =>
         unwrap(
            await clack.select({
               message: options.message,
               options: toOptions(options.choices),
               initialValue: options.initialValue
            })
         ),
      multiselect: async options =>
         unwrap(
            await clack.multiselect({
               message: options.message,
               options: toOptions(options.choices),
               initialValues: options.initialValues ? [...options.initialValues] : [],
               // Legal and meaningful: an `lsp`-only project is a plain LSP
               // server, so an empty selection must not be rejected.
               required: false
            })
         ),
      confirm: async options => unwrap(await clack.confirm({ message: options.message, initialValue: options.initialValue })),
      outro: message => clack.outro(message)
   };
}
