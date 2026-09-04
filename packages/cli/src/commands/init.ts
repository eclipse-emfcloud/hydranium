/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildInitTemplates, readFrameworkVersion, UNPUBLISHED_FRAMEWORK_VERSION } from './init-templates.js';
import { createNodeWorkspaceProbe, detectWorkspace, type JsonValue, type WorkspaceProbe } from './init-workspace.js';

/**
 * The protocol heads a scaffold can start, in composition order.
 *
 * `lsp` is mandatory rather than optional: it owns the workspace, the build
 * pipeline and the shared service tier every other head reads through, so a
 * project without it has nothing for `data` or `glsp` to serve.
 */
export const INIT_HEADS = ['lsp', 'data', 'glsp'] as const;

/** One protocol head — see {@link INIT_HEADS}. */
export type InitHead = (typeof INIT_HEADS)[number];

/** The heads a scaffold emits when `--heads` is not given. */
export const DEFAULT_INIT_HEADS: readonly InitHead[] = ['lsp', 'data'];

/** True for a string naming one of {@link INIT_HEADS}. */
export function isInitHead(value: string): value is InitHead {
   return (INIT_HEADS as readonly string[]).includes(value);
}

/**
 * One grammar as the command line collected it, before any derivation.
 *
 * Everything but {@link name} is optional: the derivation rules produce a usable
 * routing key and extension from the project and grammar names alone. An
 * override is for the case derivation cannot reach — a file extension that is
 * not the kebab grammar name.
 */
export interface InitGrammarSpec {
   /** PascalCase grammar name — the `grammar X` declaration. */
   readonly name: string;
   /**
    * File extensions, leading dot optional. Defaults to the kebab grammar id.
    *
    * A list rather than a single value because `langium-config.json`'s
    * `fileExtensions` is a list: one language may answer for several suffixes.
    */
   readonly extensions?: readonly string[];
   /** Override the derived routing key. */
   readonly languageId?: string;
   /**
    * Scaffold a GLSP diagram for this grammar. Requires the `glsp` head.
    *
    * Per grammar rather than per project because
    * `AbstractHydraniumGlspDiagramModule.declareLanguage()` returns ONE grammar's
    * `LanguageMetaData` — a diagram type has exactly one grammar, and a grammar
    * with no diagram sitting on the same server is the normal case.
    */
   readonly diagram?: boolean;
}

/**
 * The resolved names of ONE grammar — the per-language tier.
 *
 * Everything here gains a sibling per additional grammar, which is what
 * separates it from {@link InitComposition}'s project-level fields. The
 * generated-symbol split is the reason the tiers cannot be collapsed:
 * `langium-cli` emits `<grammar>GeneratedModule` and `<grammar>LanguageMetaData`
 * per grammar, but `<projectName>AstReflection` and
 * `<projectName>GeneratedSharedModule` once per project.
 */
export interface InitGrammarNames {
   /** PascalCase grammar name — the `grammar X` declaration. */
   readonly grammar: string;
   /** Kebab grammar id — names the `.langium` file. */
   readonly grammarId: string;
   /**
    * Kebab routing key — the `langium-config.json` entry id.
    *
    * Qualified as `<projectId>-<grammarId>` whenever the grammar is separately
    * named or the project holds more than one, because a second grammar needs a
    * second id and retro-fitting the suffix later renames a routing key every
    * host has already bound.
    */
   readonly languageId: string;
   /** File extensions without leading dots. At least one. */
   readonly extensions: readonly string[];
   /**
    * The grammar's entry rule, always `<Grammar>Model`.
    *
    * **Derived rather than fixed, because one `langium-cli` run over N grammars
    * emits ONE combined `ast.ts` sharing one reflection.** Two grammars both
    * declaring `entry Model:` would put the same interface name in that module
    * twice.
    */
   readonly entryRule: string;
   /**
    * The starter node rule, always `<Grammar>Node`.
    *
    * **`Node` and not `Element`:** the transfer-model generator emits
    * `export interface <projectName>Element` as the base type every rule
    * extends, so a rule named `<Grammar>Element` would collide with it in the
    * single-grammar case — the same interface declared twice, the second
    * extending itself.
    */
   readonly nodeRule: string;
   /** Whether a GLSP diagram is scaffolded for this grammar. */
   readonly diagram: boolean;
}

/**
 * Where a scaffold sits inside an existing npm workspace.
 *
 * Detected rather than asked, because both members are things a wrong answer
 * makes actively broken rather than merely unidiomatic: a `--prefix` that names
 * the wrong directory runs the wrong package's scripts, and an `extends` that
 * points at a *solution* tsconfig (`files: []` plus `references`, which is what
 * a monorepo root usually has) inherits no compiler options at all.
 */
export interface InitWorkspacePlacement {
   /** POSIX path of the target relative to the workspace root, e.g. `packages/foo`. */
   readonly targetPath: string;
   /** Relative specifier of the tsconfig carrying `compilerOptions`, e.g. `../../tsconfig.base.json`. */
   readonly baseTsconfig?: string;
   /** That tsconfig's `compilerOptions`, so the emitted one can omit what it would inherit unchanged. */
   readonly baseCompilerOptions?: Readonly<Record<string, JsonValue>>;
   /** The workspace's prettier `printWidth`, so emitted sources wrap where the repo wraps. */
   readonly printWidth?: number;
   /** Filename of the workspace's eslint config; its presence is what makes the scaffold emit a `lint` script. */
   readonly eslintConfig?: string;
}

/**
 * How the emitted `package.json` presents itself.
 *
 * Separate from {@link InitWorkspacePlacement} because the two answer to
 * different authorities: the placement is *detected* from the surrounding tree,
 * while the scope and the publishability are **intent** and are never inferred —
 * a repo's root manifest is routinely named for the repo rather than for the
 * scope it publishes under, so guessing would confidently produce the wrong
 * package name. The wizard offers a sibling-derived default; the flags decide.
 *
 * This is the one place the two polarities meet: every option surface upstream
 * carries `public`, because a flag names a DEVIATION from the default, while
 * this type carries `private`, because that is the manifest key the template
 * substitutes.
 */
export interface InitPackaging {
   /** npm scope for the package name, e.g. `@acme`. Absent leaves it unscoped. */
   readonly scope?: string;
   /** Emit `"private": true` — a package npm refuses to publish. */
   readonly private: boolean;
   /** The workspace the package joins. Absent for a standalone project. */
   readonly workspace?: InitWorkspacePlacement;
}

/**
 * A standalone, unscoped, unpublishable package — what `init` emits without the
 * packaging flags.
 *
 * `private` defaults to TRUE because the manifest also declares `license:
 * "UNLICENSED"`, and a package that grants no rights while being publishable to
 * a public registry asserts two contradictory things about itself. npm pairs
 * those two keys for exactly this reason. The scaffold cannot pick a licence for
 * a stranger's project, so it withholds publication instead of granting rights
 * nobody chose; `--public` is the opt-out for a project that has picked one.
 */
export const STANDALONE_PACKAGING: InitPackaging = { private: true };

/**
 * The full scaffold description: one project tier, N grammar tiers. Templates
 * read this and are rendered per tier.
 */
export interface InitComposition {
   /** PascalCase project name — the Langium `projectName`. */
   readonly name: string;
   /**
    * Kebab project id, always derived from {@link name} and never from a
    * language id. Names what a second grammar must not rename: the package and
    * `bin` key, the DI module file, and the data-server port command (there is
    * one data server per project, not one per language).
    */
   readonly projectId: string;
   /** The protocol heads to start, always including `lsp`. */
   readonly heads: readonly InitHead[];
   /** The grammars, in the order given. The first is the configuration root. */
   readonly grammars: readonly InitGrammarNames[];
   /** How the emitted `package.json` presents itself, and where it sits. */
   readonly packaging: InitPackaging;
   /**
    * The framework version every emitted `@hydranium/*` pin is derived from —
    * the scaffolding CLI's own, since the scope is versioned as one line.
    *
    * Carried on the composition rather than read where the templates render, so
    * {@link planInitFiles} stays pure over its input. That is what lets a golden
    * pin the emitted shape at a fixed token without pinning the number, which
    * would otherwise turn every release into a red suite.
    */
   readonly frameworkVersion: string;
}

/** One file the scaffold writes: relative path + fully-substituted content. */
export interface InitFile {
   path: string;
   content: string;
}

/** Options for the {@link runInit} subcommand. */
export interface InitCommandOptions {
   /** Target directory to scaffold into. */
   readonly targetDir: string;
   /** PascalCase project name (drives the services + shared generated module names). */
   readonly name: string;
   /**
    * The grammars to scaffold, in order. Defaults to a single grammar named
    * after the project, which is the single-language starter shape.
    */
   readonly grammars?: readonly InitGrammarSpec[];
   /** The protocol heads to start. Defaults to {@link DEFAULT_INIT_HEADS}. */
   readonly heads?: readonly InitHead[];
   /** Scaffold into a non-empty directory anyway. */
   readonly force?: boolean;
   /**
    * Scaffold a member of the surrounding npm workspace: extend its base
    * tsconfig, leave `.gitignore` to the root, and address the package by
    * `--prefix` in the scripts it prints back at itself. Errors when no ancestor
    * declares `workspaces`, rather than silently degrading to a standalone
    * project the caller did not ask for.
    */
   readonly monorepo?: boolean;
   /** npm scope for the package name, e.g. `@acme`. */
   readonly scope?: string;
   /** Omit `"private": true`, leaving the package publishable. */
   readonly public?: boolean;
   /** Output sink. Default: `process.stdout.write`. Tests inject a capturing stub. */
   readonly write?: (line: string) => void;
   /** Filesystem port for workspace detection. Default: the real filesystem. */
   readonly probe?: WorkspaceProbe;
   /** Test-only: capture the planned files instead of writing to disk. */
   readonly __writeFilesForTest?: (targetDir: string, files: readonly InitFile[]) => void;
}

/** Kebab-case a PascalCase/camelCase name. */
export function kebab(name: string): string {
   return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** True for a PascalCase identifier legal as a generated TypeScript symbol prefix. */
function isPascalIdentifier(value: string): boolean {
   return /^[A-Za-z][A-Za-z0-9]*$/.test(value);
}

/** Strip a leading dot and reject an extension that is empty or dotted through. */
function normalizeExtension(value: string, grammar: string): string {
   const extension = value.replace(/^\./, '');
   if (extension.length === 0) {
      throw new Error(`Invalid extension '${value}' for grammar '${grammar}': an extension cannot be empty.`);
   }
   return extension;
}

/**
 * Resolve one grammar's names.
 *
 * `qualify` comes from the project rather than the grammar: a lone grammar
 * whose name matches the project keeps the bare project id, but as soon as
 * there are several every id is qualified, so the set reads consistently
 * instead of one member being special.
 */
function resolveGrammar(spec: InitGrammarSpec, projectId: string, qualify: boolean, diagram: boolean): InitGrammarNames {
   if (!isPascalIdentifier(spec.name)) {
      throw new Error(
         `Invalid --grammar '${spec.name}': must be a PascalCase identifier (letters and digits, starting with a letter), e.g. 'Domain'.`
      );
   }
   const grammarId = kebab(spec.name);
   const extensions = (spec.extensions ?? [grammarId]).map(extension => normalizeExtension(extension, spec.name));
   if (extensions.length === 0) {
      throw new Error(`Invalid --extensions for grammar '${spec.name}': at least one extension is required.`);
   }
   return {
      grammar: spec.name,
      grammarId,
      languageId: spec.languageId ?? (qualify || grammarId !== projectId ? `${projectId}-${grammarId}` : projectId),
      extensions,
      entryRule: `${spec.name}Model`,
      nodeRule: `${spec.name}Node`,
      diagram
   };
}

/**
 * Resolve which grammars get a diagram.
 *
 * With the `glsp` head on and nothing marked, a lone grammar is unambiguous and
 * is taken as the diagram's; with several it is a real choice, so it is required
 * rather than guessed — binding a diagram to the wrong grammar surfaces much
 * later as references resolving against the wrong scope.
 */
function resolveDiagrams(specs: readonly InitGrammarSpec[], heads: readonly InitHead[]): boolean[] {
   const marked = specs.map(spec => spec.diagram === true);
   if (!heads.includes('glsp')) {
      const named = specs.filter(spec => spec.diagram === true).map(spec => spec.name);
      if (named.length > 0) {
         throw new Error(
            `--diagram was given for ${named.join(', ')} but the head set is '${heads.join(',')}'. ` +
               "Add 'glsp' to --heads, since the emitted dependencies follow the head set."
         );
      }
      return marked;
   }
   if (marked.some(Boolean)) {
      return marked;
   }
   if (specs.length === 1) {
      return [true];
   }
   throw new Error(
      `--heads includes 'glsp' but no grammar carries --diagram. Mark the one the diagram edits: ` +
         `${specs.map(spec => spec.name).join(', ')}.`
   );
}

/** Validate the head set: known names only, and `lsp` present. */
function resolveHeads(heads: readonly InitHead[] | undefined): readonly InitHead[] {
   const resolved = heads === undefined || heads.length === 0 ? DEFAULT_INIT_HEADS : heads;
   const unknown = resolved.filter(head => !isInitHead(head));
   if (unknown.length > 0) {
      throw new Error(`Unknown head(s) '${unknown.join(', ')}': expected one of ${INIT_HEADS.join(', ')}.`);
   }
   if (!resolved.includes('lsp')) {
      throw new Error(
         "--heads must include 'lsp': it owns the workspace, the build pipeline and the shared service tier the other heads read through."
      );
   }
   // De-duplicated and put back in composition order, so the order the heads
   // were named in does not change the emitted project.
   return INIT_HEADS.filter(head => resolved.includes(head));
}

/**
 * Reject the collisions that would otherwise surface as a confusing generator
 * or runtime failure rather than as a bad invocation.
 *
 * The extension check is the one worth having: Langium routes documents to a
 * language BY extension, so two grammars claiming `.foo` is not a name clash
 * but a silent mis-route of every `.foo` file to whichever language registered
 * first.
 */
function assertNoCollisions(grammars: readonly InitGrammarNames[]): void {
   const byGrammarId = new Map<string, string>();
   const byLanguageId = new Map<string, string>();
   const byExtension = new Map<string, string>();
   for (const grammar of grammars) {
      const clashingName = byGrammarId.get(grammar.grammarId);
      if (clashingName !== undefined) {
         throw new Error(`Duplicate grammar '${grammar.grammar}': it resolves to the same file as '${clashingName}'.`);
      }
      byGrammarId.set(grammar.grammarId, grammar.grammar);

      const clashingLanguage = byLanguageId.get(grammar.languageId);
      if (clashingLanguage !== undefined) {
         throw new Error(`Duplicate language id '${grammar.languageId}': claimed by both '${clashingLanguage}' and '${grammar.grammar}'.`);
      }
      byLanguageId.set(grammar.languageId, grammar.grammar);

      for (const extension of grammar.extensions) {
         const clashingExtension = byExtension.get(extension);
         if (clashingExtension !== undefined) {
            throw new Error(
               `File extension '.${extension}' is claimed by both '${clashingExtension}' and '${grammar.grammar}'. ` +
                  'Langium routes documents by extension, so each grammar needs its own.'
            );
         }
         byExtension.set(extension, grammar.grammar);
      }
   }
}

/**
 * Derive the whole scaffold description from `--name` plus the collected
 * grammars. Throws on a name that is not a valid PascalCase identifier — both
 * project and grammar names become prefixes of generated TypeScript symbols.
 *
 * With no grammars given, one is synthesised from the project name, which is
 * the single-language starter shape.
 */
export function resolveInitComposition(
   name: string,
   grammars: readonly InitGrammarSpec[] = [],
   heads?: readonly InitHead[],
   packaging: InitPackaging = STANDALONE_PACKAGING
): InitComposition {
   if (!isPascalIdentifier(name)) {
      throw new Error(
         `Invalid --name '${name}': must be a PascalCase identifier (letters and digits, starting with a letter), e.g. 'Bookstore'.`
      );
   }
   const projectId = kebab(name);
   if (packaging.scope !== undefined && !/^@[a-z0-9][a-z0-9._-]*$/.test(packaging.scope)) {
      throw new Error(`Invalid --scope '${packaging.scope}': an npm scope starts with '@', e.g. '@acme'.`);
   }
   const resolvedHeads = resolveHeads(heads);
   const specs = grammars.length > 0 ? grammars : [{ name }];
   const diagrams = resolveDiagrams(specs, resolvedHeads);
   const resolved = specs.map((spec, index) => resolveGrammar(spec, projectId, specs.length > 1, diagrams[index]));
   assertNoCollisions(resolved);
   return { name, projectId, heads: resolvedHeads, grammars: resolved, packaging, frameworkVersion: readFrameworkVersion() };
}

/**
 * Plan the files a scaffold emits — every template rendered for this
 * composition. Pure over its input → unit-testable without touching disk;
 * {@link runInit} is the thin IO wrapper.
 */
export function planInitFiles(composition: InitComposition): InitFile[] {
   return buildInitTemplates(composition);
}

/** True when `dir` exists and contains at least one entry. */
export function isNonEmptyDir(dir: string): boolean {
   return fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0;
}

/** The packaging flags, plus the workspace they were given in. */
export interface InitPackagingOptions {
   readonly monorepo?: boolean;
   readonly scope?: string;
   readonly public?: boolean;
   readonly probe?: WorkspaceProbe;
}

/**
 * Resolve the packaging tier for a target directory, running workspace
 * detection when `--monorepo` asked for it.
 *
 * Exported because the `init`-provenance gate re-runs the reference example's
 * recorded invocation and must reach the same composition `runInit` would: a
 * second copy of these rules there would drift from these, and the gate exists
 * precisely to catch drift.
 */
export function resolveInitPackaging(targetDir: string, options: InitPackagingOptions): InitPackaging {
   if (options.monorepo !== true) {
      return { scope: options.scope, private: options.public !== true };
   }
   const detection = detectWorkspace(targetDir, options.probe ?? createNodeWorkspaceProbe());
   if (detection === undefined) {
      throw new Error(
         `--monorepo was given but no ancestor of '${path.resolve(targetDir)}' has a package.json declaring 'workspaces'. ` +
            'Scaffold without it for a standalone project.'
      );
   }
   return {
      scope: options.scope,
      private: options.public !== true,
      // The scope and the publishability deliberately do NOT fall back to what
      // detection found: the emitted package name stays a function of the argv
      // alone, which is what lets the wizard's echoed command reproduce the
      // scaffold anywhere. Detection only supplies the wizard's DEFAULT answer.
      workspace: {
         targetPath: detection.targetPath,
         baseTsconfig: detection.baseTsconfig,
         baseCompilerOptions: detection.baseCompilerOptions,
         printWidth: detection.printWidth,
         eslintConfig: detection.eslintConfig
      }
   };
}

/**
 * Scaffold a new Hydranium language project end-to-end: one starter grammar per
 * `--grammar`, `create<Name>Services` DI wiring, a launcher for each head in
 * `--heads`, `langium-config.json`, `package.json`, and scripts. Does NOT run `npm install`
 * or `langium generate` — those are printed as next steps, so the command stays
 * offline and side-effect-free beyond the files it writes. Refuses a non-empty
 * target directory unless `force`.
 */
export function runInit(options: InitCommandOptions): void {
   const write = options.write ?? ((line: string) => process.stdout.write(line));
   const targetDir = path.resolve(options.targetDir);
   const detection = options.monorepo ? detectWorkspace(targetDir, options.probe ?? createNodeWorkspaceProbe()) : undefined;
   const composition = resolveInitComposition(options.name, options.grammars, options.heads, resolveInitPackaging(targetDir, options));

   if (!options.force && isNonEmptyDir(targetDir)) {
      throw new Error(`Target directory '${targetDir}' is not empty. Pass --force to scaffold into it anyway.`);
   }

   const files = planInitFiles(composition);
   if (options.__writeFilesForTest) {
      options.__writeFilesForTest(targetDir, files);
   } else {
      for (const file of files) {
         const absolute = path.join(targetDir, file.path);
         fs.mkdirSync(path.dirname(absolute), { recursive: true });
         fs.writeFileSync(absolute, file.content, 'utf-8');
      }
   }

   const grammarList = composition.grammars.map(grammar => (grammar.diagram ? `${grammar.grammar} (diagram)` : grammar.grammar)).join(', ');
   write(
      `Scaffolded ${composition.name} (${files.length} files, heads: ${composition.heads.join(',')}, ` +
         `${composition.grammars.length} grammar(s): ${grammarList}) into ${targetDir}\n`
   );
   if (detection !== undefined) {
      write('\n');
      write(`Workspace root: ${detection.rootDir}\n`);
      if (detection.baseTsconfig !== undefined) {
         write(`  tsconfig.json extends ${detection.baseTsconfig}, minus the options it inherits unchanged.\n`);
      } else {
         write('  No root tsconfig carries compilerOptions, so the emitted one stands alone.\n');
      }
      write("  .gitignore holds `syntaxes/` only — the workspace root's covers the rest.\n");
      if (detection.printWidth !== undefined) {
         write(`  Sources wrapped at ${detection.printWidth} columns, from ${detection.rootDir}'s prettier config.\n`);
      }
      if (detection.eslintConfig !== undefined) {
         write(`  A lint script was added — ${detection.eslintConfig} says this repo lints. Adjust it if your invocation differs.\n`);
      }
      // Printed rather than applied: `init` writes inside the target directory
      // and nowhere else, so a scaffold can never surprise-edit a manifest that
      // is under review, mid-rebase, or simply not the caller's to change.
      if (detection.coveredBy === undefined) {
         write(`  Add this to "workspaces" in ${path.join(detection.rootDir, 'package.json')}:\n`);
         write(`    "${detection.targetPath}"\n`);
      } else {
         write(`  Already covered by the "${detection.coveredBy}" workspaces entry — no root manifest change needed.\n`);
      }
      if (composition.packaging.scope === undefined && detection.scope !== undefined) {
         write(`  Sibling packages all use the "${detection.scope}" scope; pass --scope ${detection.scope} to match them.\n`);
      }
   }
   write('\n');
   write('Next steps:\n');
   write(`  cd ${options.targetDir}\n`);
   // The warning is conditional on the pins this scaffold actually carries — see
   // `UNPUBLISHED_FRAMEWORK_VERSION`.
   write(
      composition.frameworkVersion === UNPUBLISHED_FRAMEWORK_VERSION
         ? '  npm install              # 404s until @hydranium/* is published — see README\n'
         : '  npm install\n'
   );
   write('  npm run build            # langium generate + tsc\n');
   write('  npm test                 # the scaffolded DI-composition test\n');
   // `npx`, not a bare invocation: `@hydranium/cli` is a devDependency of the
   // scaffold, so the binary is on PATH inside an npm script and nowhere else.
   write('  npx hydranium-cli reflect --services ./lib/services.js\n');
   write('\n');
   write('The emitted sources carry no license header — run your own header tool if\n');
   write('your repo gates them. See the README section on that.\n');
}
