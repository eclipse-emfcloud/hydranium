/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The wizard, driven through a scripted {@link PromptPort}.
 *
 * The port is semantic (`text` / `select` / `multiselect` / `confirm`), so these
 * tests exercise the real flow — the grammar loop, the conditional diagram
 * question, the workspace branch — without a TTY, without ANSI parsing and
 * without `@clack/prompts` in the assertion path. What is asserted is the argv,
 * because the argv IS the wizard's product: anything it cannot express is a
 * capability that would have drifted away from the flags.
 */

import { describe, expect, it } from 'vitest';
import { InitWizardCancelled, type PromptPort, type PromptTextOptions } from '../src/commands/init-prompt.js';
import { composeInitArgv, formatCommand, pascalCase, runInitWizard } from '../src/commands/init-wizard.js';
import { resolveInitComposition } from '../src/commands/init.js';
import type { WorkspaceDetection } from '../src/commands/init-workspace.js';

/** One scripted answer, in the order the flow asks for it. */
type Answer = string | boolean | string[];

interface ScriptedPrompt extends PromptPort {
   /** Every question message, in order — so a test can assert what was NOT asked. */
   readonly asked: readonly string[];
   /** Validation messages the scripted answers provoked. */
   readonly rejected: readonly string[];
   /** The message passed to `outro` — the echoed command. */
   readonly echoed: () => string | undefined;
}

/**
 * A port that answers from a queue.
 *
 * `text` re-takes from the queue while validation fails, which is what makes the
 * re-ask path testable: a script can supply a bad answer followed by a good one
 * and assert both that it was rejected and that the flow recovered.
 */
function scriptedPrompt(answers: readonly Answer[]): ScriptedPrompt {
   const queue = [...answers];
   const asked: string[] = [];
   const rejected: string[] = [];
   let echoed: string | undefined;
   const take = (message: string): Answer => {
      asked.push(message);
      if (queue.length === 0) {
         throw new Error(`Scripted prompt ran out of answers at '${message}'.`);
      }
      return queue.shift() as Answer;
   };
   return {
      asked,
      rejected,
      echoed: () => echoed,
      intro: () => undefined,
      note: () => undefined,
      outro: message => {
         echoed = message;
      },
      text: async (options: PromptTextOptions) => {
         let value = String(take(options.message));
         for (;;) {
            const problem = options.validate?.(value);
            if (problem === undefined) {
               return value;
            }
            rejected.push(problem);
            value = String(take(`${options.message} (retry)`));
         }
      },
      select: async options => take(options.message) as never,
      multiselect: async options => take(options.message) as never,
      confirm: async options => take(options.message) as boolean
   };
}

/** The publishability question's exact message, asserted on paths that used not to reach it. */
const PUBLISHABLE = 'Publishable to npm (the manifest says UNLICENSED)?';

const DETECTION: WorkspaceDetection = {
   rootDir: '/repo',
   workspaces: ['packages/*'],
   targetPath: 'packages/order-flow',
   coveredBy: 'packages/*',
   scope: '@acme',
   baseTsconfig: '../../tsconfig.base.json',
   baseCompilerOptions: { strict: true }
};

describe('composeInitArgv', () => {
   it('emits nothing but --name when every answer matches what init derives', () => {
      const argv = composeInitArgv({
         targetDir: './bookstore',
         name: 'Bookstore',
         heads: ['lsp', 'data'],
         grammars: [{ name: 'Bookstore', extension: 'bookstore', diagram: false }],
         force: false,
         monorepo: false,
         public: false
      });
      expect(argv).toEqual(['./bookstore', '--name', 'Bookstore']);
   });

   /**
    * The defect the wizard exists to fix: `--name OrderFlow` alone yields the
    * extension `.order-flow`, and no derivation can do better. Asking turns it
    * into two flags that say exactly what was meant.
    */
   it('carries a chosen extension on a --grammar, since --extensions is grammar-scoped', () => {
      const argv = composeInitArgv({
         targetDir: './order-flow',
         name: 'OrderFlow',
         heads: ['lsp', 'data'],
         grammars: [{ name: 'OrderFlow', extension: 'order', diagram: false }],
         force: false,
         monorepo: false,
         public: false
      });
      expect(argv).toEqual(['./order-flow', '--name', 'OrderFlow', '--grammar', 'OrderFlow', '--extensions', 'order']);
      // And the argv still means what it says: the grammar stays unqualified,
      // because it is not separately NAMED from the project.
      expect(resolveInitComposition('OrderFlow', [{ name: 'OrderFlow', extensions: ['order'] }]).grammars[0]).toMatchObject({
         languageId: 'order-flow',
         extensions: ['order']
      });
   });

   it('names every grammar once there are several, and marks the diagram one', () => {
      const argv = composeInitArgv({
         targetDir: './order-flow',
         name: 'OrderFlow',
         heads: ['lsp', 'data', 'glsp'],
         grammars: [
            { name: 'Domain', extension: 'domain', diagram: false },
            { name: 'Process', extension: 'process', diagram: true }
         ],
         force: false,
         monorepo: true,
         scope: '@acme',
         public: true
      });
      expect(argv).toEqual([
         './order-flow',
         '--name',
         'OrderFlow',
         '--heads',
         'lsp,data,glsp',
         '--grammar',
         'Domain',
         '--grammar',
         'Process',
         '--diagram',
         '--monorepo',
         '--scope',
         '@acme',
         '--public'
      ]);
   });
});

describe('formatCommand', () => {
   it('leaves a comma-separated head list unquoted and quotes a path with a space', () => {
      expect(formatCommand(['./x', '--heads', 'lsp,data,glsp'])).toBe('hydranium-cli init ./x --heads lsp,data,glsp');
      expect(formatCommand(['./my project'])).toBe("hydranium-cli init './my project'");
   });
});

describe('pascalCase', () => {
   it('proposes a project name from a kebab directory', () => {
      expect(pascalCase('order-flow')).toBe('OrderFlow');
      expect(pascalCase('bookstore')).toBe('Bookstore');
   });
});

describe('runInitWizard', () => {
   it('takes the derived defaults and asks nothing about a workspace when there is none', async () => {
      const prompt = scriptedPrompt(['Bookstore', ['data'], 'Bookstore', 'bookstore', false, false]);
      const argv = await runInitWizard(prompt, () => undefined, { targetDir: './bookstore', isOccupied: () => false });

      expect(argv).toEqual(['./bookstore', '--name', 'Bookstore']);
      expect(prompt.asked.some(question => question.includes('workspace'))).toBe(false);
      // Publishability is NOT part of the workspace group, so it is still asked
      // here — and the conservative answer is what the emission already does, so
      // it contributes no flag.
      expect(prompt.asked).toContain(PUBLISHABLE);
      expect(prompt.echoed()).toBe('hydranium-cli init ./bookstore --name Bookstore');
   });

   /**
    * The publishability answer is a licence posture — the emission withholds
    * publication AND declares itself UNLICENSED — so it must not be settled by a
    * default nobody was shown. Both standalone paths leave the workspace group
    * early, and neither of them can be allowed to skip the question with it.
    */
   it('asks about publishability when no workspace was detected at all', async () => {
      const prompt = scriptedPrompt(['Bookstore', ['data'], 'Bookstore', 'bookstore', false, true]);
      const argv = await runInitWizard(prompt, () => undefined, { targetDir: './bookstore', isOccupied: () => false });

      expect(prompt.asked).toContain(PUBLISHABLE);
      expect(argv).toEqual(['./bookstore', '--name', 'Bookstore', '--public']);
   });

   it('asks about publishability when workspace membership was declined', async () => {
      const prompt = scriptedPrompt(['Bookstore', ['data'], 'Bookstore', 'bookstore', false, false, true]);
      const argv = await runInitWizard(prompt, () => DETECTION, { targetDir: './bookstore', isOccupied: () => false });

      // The membership question was reached and declined, so the scope question
      // that follows it does not run — which is what makes this the second early
      // return rather than the no-detection one.
      expect(prompt.asked).toContain('Scaffold as a member of that workspace?');
      expect(prompt.asked).not.toContain("Package scope ('-' for none)");
      expect(prompt.asked).toContain(PUBLISHABLE);
      expect(argv).toEqual(['./bookstore', '--name', 'Bookstore', '--public']);
   });

   it('collects several grammars one at a time and asks which one the diagram edits', async () => {
      const prompt = scriptedPrompt([
         'OrderFlow',
         ['data', 'glsp'],
         'Domain',
         'domain',
         true,
         'Process',
         'process',
         false,
         'Process',
         true,
         '@acme',
         true
      ]);
      const argv = await runInitWizard(prompt, () => DETECTION, { targetDir: './order-flow', isOccupied: () => false });

      expect(argv).toEqual([
         './order-flow',
         '--name',
         'OrderFlow',
         '--heads',
         'lsp,data,glsp',
         '--grammar',
         'Domain',
         '--grammar',
         'Process',
         '--diagram',
         '--monorepo',
         '--scope',
         '@acme',
         '--public'
      ]);
      expect(prompt.asked).toContain('Grammar 2 · name (PascalCase)');
      expect(prompt.asked).toContain('Which grammar does the GLSP diagram edit?');
   });

   /**
    * With one grammar the scaffolder DERIVES the diagram, so a question here
    * would offer a choice whose "no" it would then overrule.
    */
   it('does not ask which grammar the diagram edits when there is only one', async () => {
      const prompt = scriptedPrompt(['Bookstore', ['glsp'], 'Bookstore', 'bookstore', false, false]);
      const argv = await runInitWizard(prompt, () => undefined, { targetDir: './bookstore', isOccupied: () => false });

      expect(prompt.asked).not.toContain('Which grammar does the GLSP diagram edit?');
      expect(argv).toEqual(['./bookstore', '--name', 'Bookstore', '--heads', 'lsp,glsp']);
      expect(resolveInitComposition('Bookstore', [], ['lsp', 'glsp']).grammars[0].diagram).toBe(true);
   });

   it('re-asks a grammar whose extension another grammar already claimed', async () => {
      const prompt = scriptedPrompt(['OrderFlow', ['data'], 'Domain', 'shared', true, 'Process', 'shared', 'process', false, false]);
      const argv = await runInitWizard(prompt, () => undefined, { targetDir: './order-flow', isOccupied: () => false });

      expect(prompt.rejected).toContain("'.shared' is already claimed by another grammar.");
      expect(argv).toEqual([
         './order-flow',
         '--name',
         'OrderFlow',
         '--grammar',
         'Domain',
         '--extensions',
         'shared',
         '--grammar',
         'Process'
      ]);
   });

   /**
    * Asked FIRST, before the questions whose answers would be thrown away. The
    * scaffolder's own check runs only at the end, so without this the wizard
    * collects a whole project description and then refuses.
    */
   it('offers --force as the first question when the target is not empty', async () => {
      const prompt = scriptedPrompt([true, 'Bookstore', ['data'], 'Bookstore', 'bookstore', false, false]);
      const argv = await runInitWizard(prompt, () => undefined, { targetDir: './bookstore', isOccupied: () => true });

      expect(prompt.asked[0]).toBe('./bookstore is not empty — scaffold into it anyway?');
      expect(argv).toEqual(['./bookstore', '--name', 'Bookstore', '--force']);
   });

   it('ends the session when that offer is declined, asking nothing further', async () => {
      const prompt = scriptedPrompt([false]);
      await expect(runInitWizard(prompt, () => undefined, { targetDir: './bookstore', isOccupied: () => true })).rejects.toThrow(
         InitWizardCancelled
      );

      // Nothing beyond the one question: a declined target must not cost the
      // name, the heads or the grammar loop.
      expect(prompt.asked).toEqual(['./bookstore is not empty — scaffold into it anyway?']);
      expect(prompt.echoed()).toBe('Nothing scaffolded — ./bookstore is not empty.');
   });

   it('says nothing about emptiness when the target is empty', async () => {
      const prompt = scriptedPrompt(['Bookstore', ['data'], 'Bookstore', 'bookstore', false, false]);
      await runInitWizard(prompt, () => undefined, { targetDir: './bookstore', isOccupied: () => false });

      expect(prompt.asked.some(question => question.includes('not empty'))).toBe(false);
   });

   it("treats '-' as declining a package scope", async () => {
      const prompt = scriptedPrompt(['Bookstore', ['data'], 'Bookstore', 'bookstore', false, true, '-', false]);
      const argv = await runInitWizard(prompt, () => DETECTION, { targetDir: './bookstore', isOccupied: () => false });

      expect(argv).toEqual(['./bookstore', '--name', 'Bookstore', '--monorepo']);
   });
});
