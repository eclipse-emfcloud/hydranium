/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The interactive front end of `hydranium-cli init`.
 *
 * **The wizard's product is a command, not files.** It gathers answers, composes
 * an argv, echoes it, and hands it to the same flag parser a non-interactive
 * caller uses. Three properties fall out of that, and they are the reason to
 * prefer it over an interactive mode reaching into the scaffolder:
 *
 * - every answer is flag-expressible by construction, so no wizard-only
 *   capability can drift in;
 * - the echoed command is copy-pasteable into a README or CI, which is what
 *   keeps a recorded invocation re-runnable;
 * - the wizard reduces to a pure `answers → argv` function
 *   ({@link composeInitArgv}), far cheaper to test than a flow that also writes
 *   files.
 *
 * What it asks is deliberately short. Most `init` inputs are *derived* and stay
 * derived; the ones here are the ones no rule can reach:
 *
 * - the **file extension**, which is the defect the wizard exists to fix. A
 *   project name is silently also an extension choice, because the grammar
 *   defaults to the project name and the extension follows the grammar. No
 *   derivation can do better — with no second name supplied there is nothing to
 *   derive from — so it is asked, with the derived value merely offered as the
 *   default.
 * - **workspace membership** and scope, which are facts about the surrounding
 *   repo rather than about the language, and so are asked only where a workspace
 *   was detected.
 * - **publishability**, which is asked on every path because it is a licence
 *   posture rather than a packaging detail: the emission withholds publication
 *   AND declares itself UNLICENSED, so a default nobody was shown would settle
 *   the licence question by silence.
 *
 * The **language id is deliberately not asked**, though it is the third of the
 * three independent names: its derivation was settled and built separately
 * (`<project>`, qualified to `<project>-<grammar>` when the grammar is
 * separately named), and offering it as a question invites overriding a rule
 * that is right, in the one place a wrong answer renames a routing key every
 * host has already bound.
 *
 * Grammars are collected **one at a time** — each one's own questions together,
 * then an explicit "add another" — rather than as a count followed by N rounds
 * of interrogation. A language project has one grammar far more often than it
 * has three, and this shape charges the common case a single keystroke while
 * letting the multi-grammar case grow naturally.
 */

import * as path from 'node:path';
import { DEFAULT_INIT_HEADS, INIT_HEADS, type InitHead, isNonEmptyDir, kebab } from './init.js';
import { InitWizardCancelled, OPTIONAL_HEAD_CHOICES, type PromptPort } from './init-prompt.js';
import { type WorkspaceDetection } from './init-workspace.js';

/** One grammar as the wizard collected it. */
export interface InitGrammarAnswer {
   /** PascalCase grammar name. */
   readonly name: string;
   /** File extension for its documents, without a leading dot. */
   readonly extension: string;
   /** Scaffold a GLSP diagram for this grammar. */
   readonly diagram: boolean;
}

/** Everything the wizard collects. Pure data — {@link composeInitArgv} turns it into flags. */
export interface InitAnswers {
   /** Directory to scaffold into. */
   readonly targetDir: string;
   /** PascalCase project name. */
   readonly name: string;
   /** The protocol heads to start. */
   readonly heads: readonly InitHead[];
   /** The grammars, in the order they were given. */
   readonly grammars: readonly InitGrammarAnswer[];
   /** Scaffold into a non-empty directory anyway. */
   readonly force: boolean;
   /** Join the surrounding npm workspace. */
   readonly monorepo: boolean;
   /** npm scope for the package name, e.g. `@acme`. */
   readonly scope?: string;
   /** Leave the package publishable, which the scaffold does not do by default. */
   readonly public: boolean;
}

/** PascalCase a directory name, splitting on any non-alphanumeric run. */
export function pascalCase(value: string): string {
   return value
      .split(/[^A-Za-z0-9]+/)
      .filter(part => part.length > 0)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
}

/** True for a PascalCase identifier legal as a generated TypeScript symbol prefix. */
function isPascalIdentifier(value: string): boolean {
   return /^[A-Za-z][A-Za-z0-9]*$/.test(value);
}

/**
 * Compose the argv the answers stand for — the wizard's entire product.
 *
 * Minimal by design: a flag is emitted only where the answer differs from what
 * `init` would derive anyway, so the echoed command reads as the short thing a
 * person would have typed rather than as a transcript of the questions. The
 * extension rides on `--grammar` because `--extensions` is grammar-scoped, and
 * naming the grammar after the project leaves the derived language id alone.
 */
export function composeInitArgv(answers: InitAnswers): string[] {
   const argv = [answers.targetDir, '--name', answers.name];
   if (answers.heads.join(',') !== DEFAULT_INIT_HEADS.join(',')) {
      argv.push('--heads', answers.heads.join(','));
   }
   const several = answers.grammars.length > 1;
   for (const grammar of answers.grammars) {
      // A lone grammar named after the project, taking the derived extension, is
      // exactly what `--name` alone already means — so it contributes no flags
      // and the echoed command stays the short one a person would have typed.
      const customExtension = grammar.extension !== kebab(grammar.name);
      if (!several && grammar.name === answers.name && !customExtension && !grammar.diagram) {
         continue;
      }
      argv.push('--grammar', grammar.name);
      if (customExtension) {
         argv.push('--extensions', grammar.extension);
      }
      if (grammar.diagram) {
         argv.push('--diagram');
      }
   }
   if (answers.force) {
      argv.push('--force');
   }
   if (answers.monorepo) {
      argv.push('--monorepo');
   }
   if (answers.scope !== undefined && answers.scope.length > 0) {
      argv.push('--scope', answers.scope);
   }
   if (answers.public) {
      argv.push('--public');
   }
   return argv;
}

/** Render an argv as a copy-pasteable command line, quoting only what a shell would mangle. */
export function formatCommand(argv: readonly string[]): string {
   const quoted = argv.map(argument => (/^[A-Za-z0-9@,._/-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, "'\\''")}'`));
   return `hydranium-cli init ${quoted.join(' ')}`;
}

/** Validate a file extension, and reject one another grammar already claims. */
function extensionProblem(value: string, taken: ReadonlySet<string>): string | undefined {
   const extension = value.replace(/^\./, '');
   if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(extension)) {
      return `'${value}' is not a usable file extension.`;
   }
   // Checked here rather than left to the scaffolder so the answer is corrected
   // while the grammar that owns it is still on screen. Langium routes documents
   // to a language BY extension, so a duplicate is a silent mis-route.
   return taken.has(extension) ? `'.${extension}' is already claimed by another grammar.` : undefined;
}

/**
 * Collect one grammar's settings as a group — its own name, then its own
 * extension — so the answers stay next to the thing they describe.
 */
async function askGrammar(
   prompt: PromptPort,
   index: number,
   defaultName: string | undefined,
   takenNames: ReadonlySet<string>,
   takenExtensions: ReadonlySet<string>
): Promise<InitGrammarAnswer> {
   const label = `Grammar ${index + 1}`;
   const name = await prompt.text({
      message: `${label} · name (PascalCase)`,
      initialValue: defaultName,
      placeholder: 'Domain',
      validate: value => {
         if (!isPascalIdentifier(value)) {
            return `'${value}' is not a PascalCase identifier — letters and digits, starting with a letter.`;
         }
         return takenNames.has(value) ? `'${value}' is already used by another grammar.` : undefined;
      }
   });
   const extension = await prompt.text({
      message: `${label} · file extension`,
      initialValue: kebab(name),
      validate: value => extensionProblem(value, takenExtensions)
   });
   return { name, extension: extension.replace(/^\./, ''), diagram: false };
}

/**
 * Ask for the protocol head set.
 *
 * `lsp` is not offered, it is stated: it owns the workspace, the build pipeline
 * and the shared tier the other heads read through, so a project without it has
 * nothing for them to serve. Presenting it as a checkbox would offer a choice
 * the scaffolder then refuses.
 */
async function askHeads(prompt: PromptPort): Promise<InitHead[]> {
   const optional = await prompt.multiselect({
      message: 'Protocol heads — lsp is always included',
      choices: OPTIONAL_HEAD_CHOICES,
      initialValues: DEFAULT_INIT_HEADS.filter((head): head is Exclude<InitHead, 'lsp'> => head !== 'lsp')
   });
   const chosen = new Set<InitHead>(['lsp', ...optional]);
   return INIT_HEADS.filter(head => chosen.has(head));
}

/**
 * Mark the grammar a scaffolded diagram edits.
 *
 * Only a real question with `glsp` on AND several grammars: a diagram type
 * binds exactly ONE grammar, and with a single grammar the scaffolder derives
 * that answer already — so asking would offer a choice whose "no" it would
 * silently overrule.
 */
async function askDiagramGrammar(
   prompt: PromptPort,
   heads: readonly InitHead[],
   grammars: readonly InitGrammarAnswer[]
): Promise<InitGrammarAnswer[]> {
   if (!heads.includes('glsp') || grammars.length < 2) {
      return [...grammars];
   }
   const chosen = await prompt.select({
      message: 'Which grammar does the GLSP diagram edit?',
      choices: grammars.map(grammar => ({ value: grammar.name, label: grammar.name, hint: `.${grammar.extension}` })),
      initialValue: grammars[0].name
   });
   return grammars.map(grammar => ({ ...grammar, diagram: grammar.name === chosen }));
}

/**
 * Confirm scaffolding into a directory that already has content, returning
 * whether `--force` is needed.
 *
 * Declining ends the session rather than looping back to the target question:
 * the answer is "not here", and re-prompting for a directory would leave the
 * echoed command describing a different run than the one that was started.
 */
async function confirmOccupiedTarget(prompt: PromptPort, targetDir: string, isOccupied: (targetDir: string) => boolean): Promise<boolean> {
   if (!isOccupied(path.resolve(targetDir))) {
      return false;
   }
   const force = await prompt.confirm({ message: `${targetDir} is not empty — scaffold into it anyway?`, initialValue: false });
   if (!force) {
      prompt.outro(`Nothing scaffolded — ${targetDir} is not empty.`);
      throw new InitWizardCancelled();
   }
   return true;
}

/** Ask the workspace questions, or answer them "no" when there is no workspace to join. */
async function askWorkspaceMembership(
   prompt: PromptPort,
   detection: WorkspaceDetection | undefined
): Promise<{ monorepo: boolean; scope?: string }> {
   if (detection === undefined) {
      return { monorepo: false };
   }
   const covered =
      detection.coveredBy === undefined
         ? `The root manifest has no entry covering it, so one is printed for you to add.`
         : `Already covered by the "${detection.coveredBy}" workspaces entry.`;
   // The placement is named, not just the root. The root alone reads as "this
   // ran somewhere I did not ask for" whenever the command was issued from a
   // different directory than the target, which is the normal case.
   prompt.note(`Root:     ${detection.rootDir}\nPlacing:  ${detection.targetPath}\n${covered}`, 'Detected an npm workspace');

   const monorepo = await prompt.confirm({ message: 'Scaffold as a member of that workspace?', initialValue: true });
   if (!monorepo) {
      return { monorepo: false };
   }
   const scope = await prompt.text({
      message: "Package scope ('-' for none)",
      initialValue: detection.scope ?? '-',
      validate: value =>
         value === '-' || /^@[a-z0-9][a-z0-9._-]*$/.test(value)
            ? undefined
            : `'${value}' is not an npm scope — try '@acme', or '-' for none.`
   });
   return { monorepo, scope: scope === '-' ? undefined : scope };
}

/**
 * Ask the packaging questions.
 *
 * Workspace membership and scope are facts about a surrounding repo, so they are
 * reached only where one was detected. **Publishability is asked on every path**,
 * including a standalone project with no workspace anywhere near it: the scaffold
 * withholds publication because it also emits an UNLICENSED manifest, which makes
 * the answer a licence posture rather than a packaging detail, and a licence
 * posture must not be settled by a default nobody was shown. It knowingly spends
 * a question on the shortest path — the alternative was stating the packaging in
 * the echoed command instead, which informs whoever reads the output and still
 * decides for whoever does not.
 *
 * Asked in the negative, so the offered answer is the emission's own default and
 * a "yes" is the licence decision the adopter has to have made first.
 */
async function askPackaging(
   prompt: PromptPort,
   detection: WorkspaceDetection | undefined
): Promise<{ monorepo: boolean; scope?: string; public: boolean }> {
   const membership = await askWorkspaceMembership(prompt, detection);
   const isPublic = await prompt.confirm({ message: 'Publishable to npm (the manifest says UNLICENSED)?', initialValue: false });
   return { ...membership, public: isPublic };
}

/**
 * Run the wizard and return the argv it composed.
 *
 * `detect` is injected rather than called here so the flow stays testable
 * without a real workspace on disk, and because detection needs the target
 * directory — which is itself one of the answers.
 */
export async function runInitWizard(
   prompt: PromptPort,
   detect: (targetDir: string) => WorkspaceDetection | undefined,
   options: { readonly targetDir?: string; readonly isOccupied?: (targetDir: string) => boolean } = {}
): Promise<string[]> {
   prompt.intro('Scaffold a Hydranium language project');

   const targetDir =
      options.targetDir ??
      (await prompt.text({
         message: 'Target directory',
         placeholder: './my-language',
         validate: value => (value.length > 0 ? undefined : 'A target directory is required.')
      }));

   // Asked FIRST, not left to the scaffolder — which checks only after the whole
   // wizard has run, so a scaffold that cannot happen costs every remaining
   // question before saying so. Answering yes is exactly `--force`, which keeps
   // the recovery flag-expressible rather than a wizard-only escape.
   const force = await confirmOccupiedTarget(prompt, targetDir, options.isOccupied ?? isNonEmptyDir);

   const name = await prompt.text({
      message: 'Project name (PascalCase)',
      initialValue: pascalCase(path.basename(path.resolve(targetDir))),
      validate: value =>
         isPascalIdentifier(value) ? undefined : `'${value}' is not a PascalCase identifier — letters and digits, starting with a letter.`
   });

   const heads = await askHeads(prompt);

   // One grammar at a time, each with its own settings, then an explicit "add
   // another" — so the single-grammar case costs two keystrokes and the
   // multi-grammar one never asks for a count up front.
   const grammars: InitGrammarAnswer[] = [];
   const takenNames = new Set<string>();
   const takenExtensions = new Set<string>();
   do {
      const grammar = await askGrammar(prompt, grammars.length, grammars.length === 0 ? name : undefined, takenNames, takenExtensions);
      grammars.push(grammar);
      takenNames.add(grammar.name);
      takenExtensions.add(grammar.extension);
   } while (await prompt.confirm({ message: 'Add another grammar?', initialValue: false }));

   const withDiagram = await askDiagramGrammar(prompt, heads, grammars);
   const packaging = await askPackaging(prompt, detect(targetDir));

   const argv = composeInitArgv({ targetDir, name, heads, grammars: withDiagram, force, ...packaging });
   // Echoed as the LAST thing before the scaffold runs, because it is the
   // artefact the session produces: everything above is how it was reached.
   prompt.outro(formatCommand(argv));
   return argv;
}
