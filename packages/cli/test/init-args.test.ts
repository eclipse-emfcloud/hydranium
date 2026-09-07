/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `init`'s argv parser, and the round trip that makes the wizard honest.
 *
 * The wizard's justification is one claim: **every answer is flag-expressible,
 * and the echoed command reproduces the run.** The sibling wizard tests assert
 * the composed argv as a literal, which pins what it looks like but not what it
 * MEANS — an argv can be exactly as expected and still not describe the answers,
 * if `composeInitArgv` and the parser disagree about a flag's scope. Here the
 * argv is fed back through the parser the command line uses and the resulting
 * composition is compared against the answers it came from, which is the
 * property the design actually rests on.
 */

import { describe, expect, it } from 'vitest';
import { INIT_FLAGS, INIT_HELP, parseInitArgs } from '../src/commands/init-args.js';
import { composeInitArgv, type InitAnswers } from '../src/commands/init-wizard.js';
import { resolveInitComposition } from '../src/commands/init.js';

/** Parse without the command line's exit-on-error, so a failure is visible as a throw. */
function parse(args: string[]) {
   return parseInitArgs(args, message => {
      throw new Error(message);
   });
}

/** Answer sets spanning the shapes the wizard can produce. */
const ANSWERS: ReadonlyArray<{ label: string; answers: InitAnswers }> = [
   {
      label: 'a lone grammar taking every derived default',
      answers: {
         targetDir: './bookstore',
         name: 'Bookstore',
         heads: ['lsp', 'data'],
         grammars: [{ name: 'Bookstore', extension: 'bookstore', diagram: false }],
         force: false,
         monorepo: false,
         public: false
      }
   },
   {
      label: 'a chosen extension, which is the defect the wizard fixes',
      answers: {
         targetDir: './order-flow',
         name: 'OrderFlow',
         heads: ['lsp', 'data'],
         grammars: [{ name: 'OrderFlow', extension: 'order', diagram: false }],
         force: false,
         monorepo: false,
         public: false
      }
   },
   {
      label: 'several grammars with the diagram on the second',
      answers: {
         targetDir: './depot',
         name: 'Depot',
         heads: ['lsp', 'data', 'glsp'],
         grammars: [
            { name: 'Domain', extension: 'domain', diagram: false },
            { name: 'Process', extension: 'flow', diagram: true },
            { name: 'Layout', extension: 'layout', diagram: false }
         ],
         force: true,
         monorepo: true,
         scope: '@acme',
         public: true
      }
   },
   {
      // Reachable through the wizard only because publishability is asked on the
      // common path: a standalone project answering "yes" is the one shape where
      // `--public` travels without `--monorepo` beside it.
      label: 'a standalone project that opted into publication',
      answers: {
         targetDir: './bookstore',
         name: 'Bookstore',
         heads: ['lsp', 'data'],
         grammars: [{ name: 'Bookstore', extension: 'bookstore', diagram: false }],
         force: false,
         monorepo: false,
         public: true
      }
   },
   {
      label: 'an lsp-only project, which is a legal empty head selection',
      answers: {
         targetDir: './plain',
         name: 'Plain',
         heads: ['lsp'],
         grammars: [{ name: 'Plain', extension: 'plain', diagram: false }],
         force: false,
         monorepo: false,
         public: false
      }
   }
];

describe('the wizard argv round-trips through the parser', () => {
   it.each(ANSWERS)('reproduces $label', ({ answers }) => {
      const parsed = parse(composeInitArgv(answers));

      expect(parsed.targetDir).toBe(answers.targetDir);
      expect(parsed.name).toBe(answers.name);
      expect(parsed.force).toBe(answers.force);
      expect(parsed.monorepo).toBe(answers.monorepo);
      expect(parsed.scope).toBe(answers.scope);
      expect(parsed.public).toBe(answers.public);

      // The composition is what the scaffolder actually reads, so the claim is
      // only proved once the parsed argv resolves to the answers' own shape.
      const composition = resolveInitComposition(parsed.name as string, parsed.grammars, parsed.heads);
      expect(composition.heads).toEqual(answers.heads);
      expect(composition.grammars.map(grammar => grammar.grammar)).toEqual(answers.grammars.map(grammar => grammar.name));
      expect(composition.grammars.map(grammar => grammar.extensions[0])).toEqual(answers.grammars.map(grammar => grammar.extension));
      expect(composition.grammars.map(grammar => grammar.diagram)).toEqual(answers.grammars.map(grammar => grammar.diagram));
   });
});

describe('parseInitArgs', () => {
   /** The order-dependence that keeps this parser hand-written. */
   it('attaches a scoped flag to the grammar it follows, not to the last one named', () => {
      const parsed = parse(['./x', '--grammar', 'A', '--extensions', 'a-ext', '--grammar', 'B', '--diagram']);

      expect(parsed.grammars).toEqual([
         { name: 'A', extensions: ['a-ext'] },
         { name: 'B', diagram: true }
      ]);
   });

   it('refuses a scoped flag that follows no grammar', () => {
      expect(() => parse(['./x', '--extensions', 'a'])).toThrow(/must follow a --grammar/);
   });

   it('names the plural spelling for the singular typo', () => {
      expect(() => parse(['./x', '--extension', 'a'])).toThrow(/did you mean --extensions/);
   });

   it('rejects an unknown flag and a second positional', () => {
      expect(() => parse(['./x', '--nope'])).toThrow(/Unknown option: --nope/);
      expect(() => parse(['./x', './y'])).toThrow(/Unexpected argument: \.\/y/);
   });
});

describe('the init help text', () => {
   /**
    * Help that drifts from the parser is worse than none: it reads as
    * authoritative, so a flag missing from it is a capability nobody finds.
    *
    * Checked against the DESCRIBED options, not the whole text. A first attempt
    * asserted the flag appeared anywhere and could not fail: the usage synopsis
    * at the top already names almost every flag, so deleting a flag's actual
    * explanation left the assertion satisfied.
    */
   it('describes every flag the parser accepts, not just lists it in the synopsis', () => {
      const described = new Set(INIT_HELP.map(line => line.match(/^ {2}(--[a-z-]+)/)?.[1]).filter(Boolean));
      // An empty list would make the loop below vacuous rather than failing.
      expect(INIT_FLAGS.length, 'no accepted flags to check').toBeGreaterThan(0);
      for (const flag of INIT_FLAGS) {
         expect(described, `${flag} is accepted but has no description line`).toContain(flag);
      }
   });

   it('lists no flag the parser would reject', () => {
      // An empty list would make the loop below vacuous rather than failing.
      expect(INIT_FLAGS.length, 'no documented flags to check').toBeGreaterThan(0);
      for (const flag of INIT_FLAGS) {
         // A recognised flag never reaches the unknown-option branch. Values are
         // supplied for the ones that take them; the point is only that the
         // parser has a case for the flag at all.
         const args =
            flag === '--name' || flag === '--heads' || flag === '--scope' ? ['./x', flag, 'V'] : ['./x', '--grammar', 'G', flag, 'V'];
         expect(() => parse(args), `${flag} is documented but not accepted`).not.toThrow(/Unknown option/);
      }
   });
});
