/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Template source for the `init` scaffolding command. Every entry is a file the
 * scaffold emits, rendered from an `InitComposition` — one project tier plus N
 * grammar tiers.
 *
 * PROJECT tokens, substituted once:
 *
 * - `__NAME__` — PascalCase project name, the Langium `projectName`. Drives the
 *   SHARED generated symbols (`<name>AstReflection`,
 *   `<name>GeneratedSharedModule`), one set per project.
 * - `__PROJECT_ID__` — kebab project id, always from `__NAME__`. For
 *   project-level names a second grammar must not change: the package name and
 *   `bin` key, the DI module filename, and the data-server port command.
 * - `__CONFIG_ROOT_CONST__` — SCREAMING_SNAKE project id, naming the
 *   `lsp.configurationRoot` constant a multi-grammar project binds.
 *
 * GRAMMAR tokens, substituted once per grammar:
 *
 * - `__GRAMMAR__` — PascalCase grammar name, the `grammar X` declaration.
 *   Drives the PER-LANGUAGE generated symbols (`<grammar>GeneratedModule`,
 *   `<grammar>LanguageMetaData`).
 * - `__GRAMMAR_ID__` — kebab grammar id: the `.langium` filename.
 * - `__LANGUAGE_ID__` — kebab routing key: the `langium-config` entry id and
 *   its TextMate output.
 * - `__EXTENSION__` — the grammar's FIRST file extension, without the dot.
 * - `__ENTRY_RULE__` / `__NODE_RULE__` — `<Grammar>Model` / `<Grammar>Node`.
 *
 * **The project / grammar / language split is the point, not ceremony.** All
 * three ids hold the same value in the default single-grammar scaffold, so a
 * template that reaches for the wrong one still renders correctly — and then
 * breaks the day a second grammar arrives, renaming the package or colliding on
 * a file extension. Each token above names the tier it belongs to so that day
 * is a no-op.
 *
 * **Rule names are per-grammar and that is load-bearing.** One `langium-cli`
 * run over N grammars emits ONE combined `ast.ts` sharing one reflection, so
 * two grammars declaring `entry Model:` would put the same interface name in it
 * twice. Hence `__ENTRY_RULE__` rather than a fixed `Model`. `__NODE_RULE__` is
 * `<Grammar>Node` and deliberately not `<Grammar>Element`: the transfer-model
 * generator emits `interface <projectName>Element` as the base type every rule
 * extends, which a rule of that name would collide with.
 *
 * Kept as in-source strings (not on-disk assets) so no build-time copy step
 * is needed and the substitution is unit-testable. The `.ts` / `.langium` / JSON
 * templates are derived from the in-repo reference example so the generated project
 * compiles against the real `@hydranium/*` API once `langium generate` has run.
 *
 * Two conventions the templates follow deliberately:
 *
 * - **File-purpose prose is a `//` run, never a leading `/** … *\/` block.** A
 *   license-header tool typically REPLACES the leading block comment, so prose in
 *   that position is silently deleted the first time the adopter runs theirs. A
 *   line-comment run survives, because such tools prepend rather than replace when
 *   the file does not open with `/*`.
 * - **Wrapped at the target repo's column budget, not at a fixed one.** No single
 *   width is stable for an unknown repo — prettier's own default is 80, and 100,
 *   120 and 140 all wrap differently — so "passes a formatter check as-is" is only
 *   ever true relative to a config. A workspace scaffold reads the surrounding
 *   repo's `printWidth`; a standalone one falls back to {@link DEFAULT_COLUMNS}.
 *   Every wrap goes through {@link importList} / {@link arrayLiteral} rather than
 *   being written out by hand, because a hand-wrapped line ignores the budget and
 *   is what the detection cannot fix. A very long `--name` can still push a line
 *   over; the adopter's own formatter settles it.
 */

import { readCliVersion } from '../cli-version.js';
import type { InitComposition, InitFile, InitGrammarNames, InitHead } from './init.js';
import type { JsonValue } from './init-workspace.js';

/** One template file: its path (tokens allowed) and its content (tokens allowed). */
export interface InitTemplate {
   path: string;
   content: string;
}

/**
 * The version every framework package carries before the first release.
 *
 * A scaffold made by a CLI still at this version pins a range the registry
 * cannot serve, so the emitted README keeps its yalc note and `init` keeps its
 * install warning while — and only while — it holds: from a published CLI the
 * derived pins resolve and either note would be false as printed.
 */
export const UNPUBLISHED_FRAMEWORK_VERSION = '0.0.0';

/**
 * The version `init` pins every `@hydranium/*` dependency at: the scaffolding
 * CLI's own.
 *
 * Read rather than written down. The changesets config declares the scope
 * `fixed`, so the CLI's version IS the framework's, and a literal here would be
 * a second source of truth that a scaffold can pin from before anyone gets
 * round to updating it.
 */
export function readFrameworkVersion(): string {
   return readCliVersion();
}

/**
 * The range a scaffolded project pins a framework package at.
 *
 * Caret rather than exact: the scope's fixed versioning means a caret set can
 * only resolve to one version line, so the two-physical-copies hazard that
 * argues for exact pins cannot arise, while exact pins would deny the adopter a
 * patch release.
 */
function frameworkPin(composition: InitComposition): string {
   return `^${composition.frameworkVersion}`;
}

/** SCREAMING_SNAKE a kebab id. */
function screamingSnake(projectId: string): string {
   return projectId.replace(/-/g, '_').toUpperCase();
}

/** Substitute the project-tier tokens. */
function project(text: string, composition: InitComposition): string {
   return text
      .replace(/__NAME__/g, composition.name)
      .replace(/__PROJECT_ID__/g, composition.projectId)
      .replace(/__CONFIG_ROOT_CONST__/g, screamingSnake(composition.projectId));
}

/**
 * Substitute the grammar-tier tokens for ONE grammar.
 *
 * `__GRAMMAR__` must not be folded into `__NAME__`, nor `__GRAMMAR_ID__` into
 * `__PROJECT_ID__`: each pair holds the same value in the single-grammar
 * scaffold and diverges the moment a second grammar arrives, which is precisely
 * the case the separate tokens exist to keep correct.
 */
function grammarTier(text: string, grammar: InitGrammarNames): string {
   return text
      .replace(/__GRAMMAR_ID__/g, grammar.grammarId)
      .replace(/__GRAMMAR__/g, grammar.grammar)
      .replace(/__LANGUAGE_ID__/g, grammar.languageId)
      .replace(/__EXTENSION__/g, grammar.extensions[0])
      .replace(/__ENTRY_RULE__/g, grammar.entryRule)
      .replace(/__NODE_RULE__/g, grammar.nodeRule);
}

/** Render both tiers for a single-grammar file. */
function render(text: string, composition: InitComposition, grammar: InitGrammarNames): string {
   return grammarTier(project(text, composition), grammar);
}

/** A comma-separated list of single-quoted TypeScript/JS string literals. */
function quotedList(values: readonly string[]): string {
   return values.map(value => `'${value}'`).join(', ');
}

/**
 * The column budget the emitted sources wrap at when nothing better is known.
 *
 * **Not "prettier's default"** — that is 80. 120 is a choice, and stating it as
 * a default was wrong in a way that mattered: no single width is stable for an
 * unknown repo, so emitted code only passes a formatter check relative to a
 * config. A workspace scaffold detects the surrounding repo's `printWidth` and
 * uses it (see {@link columnsFor}); a standalone one has no config to read and
 * falls back here.
 */
const DEFAULT_COLUMNS = 120;

/** The width THIS composition wraps at: the detected workspace one, else {@link DEFAULT_COLUMNS}. */
function columnsFor(composition: InitComposition): number {
   return composition.packaging.workspace?.printWidth ?? DEFAULT_COLUMNS;
}

/**
 * A named import on one line while it fits the column budget, else one symbol
 * per line. Emitted files are supposed to pass a prettier check as-is, and the
 * generated-module import grows by one symbol per grammar.
 */
function importList(symbols: readonly string[], from: string, columns: number, typeOnly = false): string {
   const keyword = typeOnly ? 'import type' : 'import';
   const single = `${keyword} { ${symbols.join(', ')} } from '${from}';`;
   return single.length <= columns ? single : `${keyword} {\n${symbols.map(symbol => `   ${symbol}`).join(',\n')}\n} from '${from}';`;
}

/** An array literal on one line while it fits at `indent`, else one element per line. */
function arrayLiteral(elements: readonly string[], indent: string, columns: number): string {
   const single = `[${elements.join(', ')}]`;
   return `${indent}${single}`.length <= columns
      ? single
      : `[\n${elements.map(element => `${indent}   ${element}`).join(',\n')}\n${indent}]`;
}

/**
 * The FRAMEWORK packages each head adds, carrying no version: every
 * `@hydranium/*` pin is derived at scaffold time from {@link frameworkPin}, so
 * none of them can name a version its siblings were not published at.
 */
const HEAD_FRAMEWORK_DEPENDENCIES: Record<InitHead, readonly string[]> = {
   lsp: ['@hydranium/core', '@hydranium/langium', '@hydranium/protocol'],
   data: ['@hydranium/data-server'],
   glsp: ['@hydranium/glsp-server']
};

/**
 * The third-party runtime dependencies each head adds, read off a working
 * project rather than guessed.
 *
 * **This is why the head axis exists.** Keyed per head rather than emitted as
 * one fixed list, because otherwise an adopter who adds a head hand-maintains
 * its dependencies too, and the two drift apart until a lint rule catches the
 * undeclared packages.
 *
 * **These literals are the only hand-maintained versions the scaffold emits, and
 * a bump of the framework's own pinned chain does not touch them.** A scaffolded
 * project pinning a different `langium` than the framework was built against
 * resolves a second physical copy, which is the identity failure the repo's
 * `overrides` block exists to prevent — so a repo gate holds each entry here
 * against the manifest that declares it.
 *
 * `langium` is required by `lsp` even though hand-written code goes through the
 * `@hydranium/langium` chokepoint, because `langium-cli` emits direct imports
 * into the generated files and regenerates them on every build.
 */
const HEAD_THIRD_PARTY_DEPENDENCIES: Record<InitHead, Readonly<Record<string, string>>> = {
   lsp: {
      langium: '4.3.1',
      'vscode-languageserver': '~10.0.1'
   },
   data: {},
   glsp: {
      '@eclipse-glsp/graph': '2.7.0',
      '@eclipse-glsp/server': '2.7.0',
      // `^6.1.3` and NOT `^6.0.0`: `@eclipse-glsp/server@2.7.0` requires it, and
      // `^6.0.0` resolved only because the hoisted copy happened to satisfy it.
      inversify: '^6.1.3',
      'reflect-metadata': '~0.2.2'
   }
};

/** The dependency block for a head set, merged and sorted as npm writes it. */
function dependencyBlock(composition: InitComposition, indent: string): string {
   const merged: Record<string, string> = {};
   for (const head of composition.heads) {
      Object.assign(merged, HEAD_THIRD_PARTY_DEPENDENCIES[head]);
      for (const framework of HEAD_FRAMEWORK_DEPENDENCIES[head]) {
         merged[framework] = frameworkPin(composition);
      }
   }
   return Object.keys(merged)
      .sort()
      .map(name => `${indent}"${name}": "${merged[name]}"`)
      .join(',\n');
}

// JSON at two-space indent, not the three the `.ts` templates use: that is the
// npm convention, and `npm install` rewrites `package.json` at two spaces
// regardless — so three would not survive the adopter's first install.
//
// The KEY ORDER is `prettier-plugin-packagejson`'s canonical one, `private`
// before `license` included. Any other order is rewritten by the scaffolded
// project's own first `format` run — a diff on a file the adopter never touched
// — and it makes a byte-compare against a formatted copy of this emission
// unsatisfiable, since both tools own the file.
//
// `private` and `license` are ONE decision, not two independent keys: a manifest
// declaring UNLICENSED grants no rights, so leaving it publishable to a public
// registry asserts the opposite of what it grants. The scaffold cannot choose a
// licence for a stranger's project, so it withholds publication instead, and
// `--public` is the opt-out once the project has chosen one.
//
// `files` is what keeps the first `npm publish` from succeeding with an unusable
// tarball. With no `files` and no `.npmignore`, npm falls back to `.gitignore`,
// which this scaffold also emits with `lib/` in it: npm force-includes `main`
// and OMITS the `bin` target beside it, so the package installs and the binary
// is missing. `syntaxes` is listed because the TextMate grammar is generated
// from this package's own grammar and can reach a consumer from nowhere else; a
// listed path that does not exist yet is inert.
//
// `repository` is deliberately NOT emitted while `author` is emitted empty. An
// empty `author` is the form `npm init` itself writes and asserts nothing, but
// `repository` is CONSUMED — the registry page, `npm repo` and publish
// provenance all follow it — so an empty or invented value sends a reader
// somewhere wrong rather than nowhere. A scaffold has no way to learn the real
// one: a standalone target has no surrounding repository at all.
const PACKAGE_JSON = `{
  "name": "__PACKAGE_NAME__",
  "version": "0.0.0",
__PRIVATE__  "description": "__NAME__ language server, built with the Hydranium framework.",
  "keywords": [
    "hydranium",
    "langium",
    "language-server",
    "__PROJECT_ID__"
  ],
  "license": "UNLICENSED",
  "author": "",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "bin": {
__BIN__  },
  "files": [
    "lib",
    "src",
    "syntaxes"
  ],
  "scripts": {
    "build": "npm run generate && tsc",
    "clean": "rimraf lib syntaxes src/language-server/generated src/language-server/generated-hydranium tsconfig.tsbuildinfo",
    "generate": "npm run langium:generate && npm run generate:transfer-model",
    "generate:transfer-model": "hydranium-cli generate-transfer-model --ast-file src/language-server/generated/ast.ts --augmentation-file src/language-server/ast.ts --out-file src/language-server/generated-hydranium/transfer-model.ts --ast-builder-file src/language-server/generated-hydranium/ast-builder.ts --element-type-name __NAME__Element --terminals-name __NAME__Terminals --regen-command \\"Run: __NPM_RUN__ generate:transfer-model\\"",
    "langium:generate": "langium generate",
    "langium:watch": "langium generate --watch",
__LINT__    "start": "node lib/main.js --stdio",
    "test": "npm run typecheck:test && vitest run",
    "typecheck:test": "tsc --noEmit -p tsconfig.test.json",
    "watch": "tsc --watch"
  },
  "dependencies": {
__DEPENDENCIES__
  },
  "devDependencies": {
    "@hydranium/cli": "__FRAMEWORK_PIN__",
    "@types/node": "^22.0.0",
    "langium-cli": "4.3.0",
    "rimraf": "^5.0.0",
    "typescript": "^5.8.0",
    "vitest": "^4.0.0"
  },
  "engines": {
    "node": ">=22.13"
  }
}
`;

/**
 * How the scaffold names `npm run` when talking about itself.
 *
 * A workspace member's scripts are routinely invoked from the repo root, where
 * a bare `npm run` reaches the ROOT manifest and fails — so the regen hint a
 * generated file prints has to name the package, or it sends every reader who
 * follows it to the wrong place.
 */
function npmRun(composition: InitComposition): string {
   const workspace = composition.packaging.workspace;
   return workspace === undefined ? 'npm run' : `npm --prefix ${workspace.targetPath} run`;
}

/**
 * The `bin` targets, one per executable entry the head set emits.
 *
 * The data entry earns a key of its own rather than an argument on the first
 * one: the two entries put DIFFERENT protocols on stdio, so a process can host
 * only one of them, and `--server` takes a command line rather than a package
 * name. Without the second key a scaffolded project has no command line that
 * reaches its own data head at all.
 *
 * Alphabetical, because `prettier-plugin-packagejson` sorts `bin` and any other
 * order is rewritten by the scaffolded project's first `format` run.
 */
function binBlock(composition: InitComposition): string {
   const entries: Array<[string, string]> = [[composition.projectId, 'lib/main.js']];
   if (composition.heads.includes('data')) {
      entries.push([`${composition.projectId}-data-server`, 'lib/data-server-main.js']);
   }
   return entries.map(([name, target]) => `    "${name}": "${target}"`).join(',\n') + '\n';
}

/** `package.json` with the name, the private flag and the dependency block all derived. */
function packageJson(composition: InitComposition): string {
   const { scope } = composition.packaging;
   const packageName = scope === undefined ? composition.projectId : `${scope}/${composition.projectId}`;
   // Emitted only where a root eslint config says the repo lints. The absence is
   // the dangerous direction: a task runner runs a script only where one is
   // declared, so a package with no `lint` is SKIPPED rather than reported, and
   // that reads as a clean lint. A wrong invocation is one visible line to edit.
   const lint = composition.packaging.workspace?.eslintConfig === undefined ? '' : '    "lint": "eslint src test --max-warnings 0",\n';
   return project(PACKAGE_JSON, composition)
      .replace('__PACKAGE_NAME__', packageName)
      .replace('__BIN__', binBlock(composition))
      .replace('__LINT__', lint)
      .replace('__PRIVATE__', composition.packaging.private ? '  "private": true,\n' : '')
      .replace('__NPM_RUN__', npmRun(composition))
      .replace('__FRAMEWORK_PIN__', frameworkPin(composition))
      .replace('__DEPENDENCIES__', dependencyBlock(composition, '    '));
}

/**
 * `projectName` is the PROJECT name, not any grammar's: one `langium-cli` run
 * over N grammars emits ONE `<projectName>AstReflection` covering all of them.
 * A second grammar is a new entry in `languages` here, never a second config.
 * `textMate.out` gives a VS Code extension its syntax highlighting; drop the
 * block if you are not shipping one.
 */
function langiumConfig(composition: InitComposition): string {
   const languages = composition.grammars
      .map(grammar =>
         [
            '    {',
            `      "id": "${grammar.languageId}",`,
            `      "grammar": "src/grammar/${grammar.grammarId}.langium",`,
            `      "fileExtensions": [${grammar.extensions.map(extension => `".${extension}"`).join(', ')}],`,
            '      "textMate": {',
            `        "out": "syntaxes/${grammar.languageId}.tmLanguage.json"`,
            '      }',
            '    }'
         ].join('\n')
      )
      .join(',\n');
   return `{
  "projectName": "${composition.name}",
  "languages": [
${languages}
  ],
  "out": "src/language-server/generated"
}
`;
}

/**
 * The compiler options the scaffold needs, as ordered data rather than as a
 * string literal.
 *
 * Structured because a workspace member emits a SUBSET of them — whatever its
 * base config does not already supply — and a second hand-maintained literal
 * for that case would drift from this one silently, which is the failure mode
 * a tsconfig is worst at reporting.
 */
const TSCONFIG_COMPILER_OPTIONS: ReadonlyArray<readonly [string, JsonValue]> = [
   ['target', 'ES2022'],
   ['lib', ['ES2022']],
   ['module', 'NodeNext'],
   ['moduleResolution', 'NodeNext'],
   ['rootDir', 'src'],
   ['outDir', 'lib'],
   ['strict', true],
   ['esModuleInterop', true],
   ['skipLibCheck', true],
   ['declaration', true],
   ['experimentalDecorators', true],
   ['emitDecoratorMetadata', true],
   ['forceConsistentCasingInFileNames', true],
   ['types', ['node']]
];

/**
 * The options that describe where THIS package's own files live. Never pruned,
 * and emitted first in the workspace case: a base config that supplied them
 * would be pointing every member at one directory, so a match there means the
 * base is wrong rather than that the member is redundant.
 */
const PACKAGE_LOCAL_OPTIONS: readonly string[] = ['rootDir', 'outDir'];

/** Compare two JSON option values. Sound here because compiler options are scalars and flat arrays. */
function jsonEquals(left: JsonValue | undefined, right: JsonValue): boolean {
   return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * `tsconfig.json`, extending the workspace's base config when there is one.
 *
 * Options are dropped only when the base supplies the SAME value, never merely
 * the same key: inheriting `"module": "CommonJS"` where the scaffold needs
 * `NodeNext` would break every emitted import, so a differing base value is a
 * reason to keep the override rather than to trust the parent.
 */
function tsconfigJson(composition: InitComposition): string {
   const workspace = composition.packaging.workspace;
   const base = workspace?.baseTsconfig === undefined ? undefined : (workspace.baseCompilerOptions ?? {});
   const options =
      base === undefined
         ? TSCONFIG_COMPILER_OPTIONS
         : [
              ...TSCONFIG_COMPILER_OPTIONS.filter(([key]) => PACKAGE_LOCAL_OPTIONS.includes(key)),
              ...TSCONFIG_COMPILER_OPTIONS.filter(([key, value]) => !PACKAGE_LOCAL_OPTIONS.includes(key) && !jsonEquals(base[key], value))
           ];
   const extendsLine = workspace?.baseTsconfig === undefined ? '' : `  "extends": "${workspace.baseTsconfig}",\n`;
   const body = options.map(([key, value]) => `    "${key}": ${JSON.stringify(value)}`).join(',\n');
   return `{\n${extendsLine}  "compilerOptions": {\n${body}\n  },\n  "include": ["src"]\n}\n`;
}

// `isolatedModules` is what makes this check agree with the transform that
// actually runs the tests. `npm test` is `typecheck:test && vitest run`, and
// vitest compiles through esbuild — a per-file transform with no type
// information, which cannot tell a re-exported TYPE from a re-exported value.
// Without the flag `tsc` accepts `export { SomeType } from './x'` that esbuild
// then emits as a real import of a symbol that does not exist at runtime, so
// the typecheck passes and the suite fails with a confusing missing-export.
const TSCONFIG_TEST = `{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true,
    "isolatedModules": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
`;

const VITEST_CONFIG = `import { defineConfig } from 'vitest/config';

// Vitest transforms TypeScript itself and resolves \`.js\` specifiers to their
// \`.ts\` source, so tests import from \`../src/\` with the same specifiers the
// compiled output uses. \`include\` is scoped to \`test/\` so \`lib/\` is never
// scanned; \`npm test\` runs \`typecheck:test\` first, because the esbuild
// transform strips types without checking them.

export default defineConfig({
   test: {
      environment: 'node',
      include: ['test/**/*.{test,spec}.ts']
   }
});
`;

const GITIGNORE = `node_modules/
lib/
*.tsbuildinfo

# Langium-generated TextMate grammar (rewritten by every \`langium generate\`).
syntaxes/
`;

/**
 * The workspace-member `.gitignore` — one entry, and the one entry a root
 * cannot be assumed to have.
 *
 * A member inherits the root's rules, and `node_modules/`, `lib/` and
 * `*.tsbuildinfo` are in every monorepo root already, so repeating them here
 * would be three lines to keep in step for no coverage. `syntaxes/` is not like
 * them: it is a Langium artefact, so a root that has never held a Langium
 * package has no rule for it, and the first `langium generate` then offers
 * generated output up for commit with nothing to warn the adopter. Dropping the
 * whole file rather than this subset is the mistake this template exists to
 * undo.
 */
const GITIGNORE_WORKSPACE_MEMBER = `# The workspace root already covers \`node_modules/\`, \`lib/\` and \`*.tsbuildinfo\`.
# It has no reason to know about this one: the TextMate grammar is a Langium
# artefact, rewritten by every \`langium generate\`, so a root that has never held
# a Langium package ignores nothing here and the generated file is offered for
# commit.
syntaxes/
`;

/** The terminals every grammar needs, shared verbatim by the fragment and the lone-grammar case. */
const TERMINALS = `hidden terminal WS: /\\s+/;
terminal ID: /[_a-zA-Z][\\w_]*/;
hidden terminal SL_COMMENT: /\\/\\/[^\\n\\r]*/;
hidden terminal ML_COMMENT: /\\/\\*[\\s\\S]*?\\*\\//;
`;

/**
 * The shared lexical fragment, emitted only for a multi-grammar project.
 *
 * The alternative — every grammar declaring its own `WS` / `ID` — lets the token
 * sets drift apart.
 */
const COMMON_GRAMMAR = `// Shared lexical basis for this project's grammars. Imported, never registered:
// it has no entry rule and no \`langium-config.json\` entry, so it is a fragment
// rather than a language.
//
// Keeping the tokens here rather than in one of the languages means a grammar
// imports \`common\` for its TOKENS and another language only when it needs that
// language's TYPES — separate reasons that are worth keeping separate.

${TERMINALS}`;

/** One starter grammar. `shared` decides whether it imports the fragment or declares its own terminals. */
function grammarFile(shared: boolean): string {
   const lexis = shared ? "import './common'\n" : `\n${TERMINALS}`;
   return `grammar __GRAMMAR__
${shared ? '\n' + lexis : ''}
// A minimal starter grammar — replace with your own language. \`__NODE_RULE__\` is
// a named, cross-referenceable node, which is enough for \`hydranium-cli reflect\`,
// \`lint-grammar\`, and \`validate\` to work out of the box.
//
// This name is the GRAMMAR's, not the project's: langium-cli emits
// \`__GRAMMAR__GeneratedModule\` from it, while \`projectName\` in
// langium-config.json emits the shared \`__NAME__GeneratedSharedModule\` and
// \`__NAME__AstReflection\`. They match by default and diverge as soon as you add
// a second grammar — that grammar gets its own name here, and the project name
// stays the umbrella.
//
// The rule names carry the grammar's prefix (\`__ENTRY_RULE__\`, \`__NODE_RULE__\`)
// because one langium-cli run over N grammars emits ONE combined \`ast.ts\`: two
// grammars both declaring \`entry Model:\` would put that interface in it twice.

entry __ENTRY_RULE__:
    (nodes+=__NODE_RULE__)*;

__NODE_RULE__:
    'node' name=ID ('->' target=[__NODE_RULE__:ID])?;
${shared ? '' : lexis}`;
}

/**
 * DI bootstrap. The single-grammar form composes one language; the multi-grammar
 * form adds each further grammar through `additionalLanguages` (one shared tier,
 * so `AstReflection`, `IndexManager` and `DocumentBuilder` are common and
 * cross-grammar references resolve through one global index) and binds
 * `lsp.configurationRoot` explicitly, which the framework warns about otherwise
 * because its default is registration order rather than a decision.
 */
function moduleFile(composition: InitComposition): string {
   const columns = columnsFor(composition);
   const [primary, ...additional] = composition.grammars;
   const multi = additional.length > 0;
   const generatedImports = [
      ...composition.grammars.map(grammar => `${grammar.grammar}GeneratedModule`),
      `${composition.name}GeneratedSharedModule`
   ];

   const configurationRoot = multi
      ? `
/** LSP settings section every language reads its configuration from. */
export const __CONFIG_ROOT_CONST___CONFIGURATION_ROOT = '__PROJECT_ID__';
`
      : '';

   const sharedModule = multi
      ? `const __NAME__SharedModule: Module<
   __NAME__SharedServices,
   PartialLangiumSharedServices & { lsp: { configurationRoot: string } }
> = {
   lsp: {
      // Several languages are registered, so the framework default ("first
      // registered id") would be registration order rather than a choice.
      configurationRoot: () => __CONFIG_ROOT_CONST___CONFIGURATION_ROOT
   }
};`
      : `const __NAME__SharedModule: Module<__NAME__SharedServices, PartialLangiumSharedServices> = {};`;

   const serializerImports = composition.grammars
      .map(grammar => `import { ${grammar.grammar}Serializer } from './${grammar.grammarId}-serializer.js';`)
      .join('\n');

   // Each language gets its own adopter module because `Serializer` is a
   // per-language slot. `additionalLanguages` defaults its `adopter` to the
   // primary's, which would give every further grammar the FIRST grammar's
   // serializer — and that one throws on a `$type` it has no emitter for.
   const languageModules = composition.grammars
      .map(
         grammar => `const ${grammar.grammar}LanguageModule: Module<__NAME__Services, PartialLangiumServices & DeepPartial<ServerAddedServices>> = {
   serializer: {
      Serializer: services => new ${grammar.grammar}Serializer(services)
   }
};`
      )
      .join('\n\n');

   const additionalLanguages = multi
      ? `,\n      additionalLanguages: ${arrayLiteral(
           additional.map(grammar => `{ generated: ${grammar.grammar}GeneratedModule, adopter: () => ${grammar.grammar}LanguageModule }`),
           '      ',
           columns
        )}`
      : '';

   const destructure = multi ? '{ shared, languages }' : '{ shared, language }';
   const returnType = composition.grammars.map(grammar => `   ${grammar.grammar}: __NAME__Services;`).join('\n');
   const returnValue = multi
      ? composition.grammars.map((grammar, index) => `${grammar.grammar}: languages[${index}]`).join(', ')
      : `${primary.grammar}: language`;

   const text = `// DI bootstrap for __NAME__. Composes the framework defaults with adopter
// overrides via Langium's \`inject()\` (through the framework's
// \`createIntegrationServices\`). Each adopter module binds ONE slot — its
// language's \`Serializer\`, which the framework cannot default because a
// concrete syntax is grammar knowledge. Everything else (scope, naming, project
// management, build pipeline) boots on the framework defaults; scope
// computation, validation checks and AST extensions go in these same modules.
//
// Note which generated symbol comes from which name: the SHARED module is
// \`__NAME__GeneratedSharedModule\` (from \`projectName\`) and there is one of it,
// while the per-language \`<Grammar>GeneratedModule\` (from each \`grammar\`
// declaration) has one per grammar.${
      multi
         ? `
//
// Every grammar here comes from ONE \`langium-cli\` run — \`AstReflection\` is a
// single shared slot, so two independently generated language packages would
// leave only the last one bound.`
         : `
//
// A second grammar goes in the \`additionalLanguages\` option of
// \`createIntegrationServices\`, generated from this same \`langium-config.json\`.`
   }

${importList(
   ['createLspServerLanguageModule', 'createLspServerSharedModule', 'type LspServerAddedServices', 'type LspServerAddedSharedServices'],
   '@hydranium/core/lsp',
   columns
)}
import { createIntegrationServices, type ServerAddedServices, type ServerModuleContext, type ServerSharedServices } from '@hydranium/core';
import { type DeepPartial, EmptyFileSystem, type Module } from '@hydranium/langium';
import { type LangiumServices, type PartialLangiumServices, type PartialLangiumSharedServices } from '@hydranium/langium/lsp';
${importList(generatedImports, './generated/module.js', columns)}
${serializerImports}

export type __NAME__SharedServices = ServerSharedServices & LspServerAddedSharedServices;
export type __NAME__Services = LangiumServices &
   ServerAddedServices &
   LspServerAddedServices & {
      shared: __NAME__SharedServices;
   };

/** What a host or a test may vary about this composition. */
export interface __NAME__Options {
   /**
    * Shared modules layered in after the framework's own bindings.
    *
    * The framework constructs most shared services with no options —
    * \`DocumentBuilder: services => new HydraniumDocumentBuilder(services)\` — so
    * rebinding the slot is the only way to boot one configured differently, and
    * a factory that hard-codes its composition leaves a test nowhere to do it.
    * That is what this is for: pass a module binding \`workspace.DocumentBuilder\`
    * to exercise a builder option, or to substitute a subclass.
    *
    * Composed LAST, after \`__NAME__SharedModule\`, so it wins over every other
    * tier including this file's own bindings — which is what makes it usable for
    * a slot the adopter overrides. Production code should not reach for it.
    */
   readonly extraSharedModules?: ReadonlyArray<Module<__NAME__SharedServices, DeepPartial<__NAME__SharedServices>>>;
}
${configurationRoot}
${sharedModule}

${languageModules}

/** Compose the Langium DI tree for __NAME__ — returns the shared + language services. */
export function create__NAME__Services(
   context: Partial<ServerModuleContext> = EmptyFileSystem,
   options: __NAME__Options = {}
): {
   shared: __NAME__SharedServices;
${returnType}
} {
   const fullContext: ServerModuleContext = { ...EmptyFileSystem, ...context };
   const ${destructure} = createIntegrationServices<ServerModuleContext, __NAME__SharedServices, __NAME__Services>({
      context: fullContext,
      sharedModules: {
         generated: __NAME__GeneratedSharedModule,
         adopter: __NAME__SharedModule,
         extra: [createLspServerSharedModule(fullContext)],
         overrides: options.extraSharedModules
      },
      languageModules: {
         generated: ${primary.grammar}GeneratedModule,
         adopter: () => ${primary.grammar}LanguageModule,
         extra: [createLspServerLanguageModule(fullContext)]
      }${additionalLanguages}
   });
   return { shared, ${returnValue} };
}
`;
   return project(text, composition);
}

const SERVICES = `// Zero-arg service factory for the headless \`hydranium-cli\` tooling: the
// \`reflect\` / \`lint-grammar\` / \`validate\` subcommands import this via
// \`--services ./lib/services.js\`. The head wires its own filesystem here.
//
// The contract is language-count-agnostic — a second grammar needs no edit here.

import { NodeFileSystem } from '@hydranium/core/node';
import { create__NAME__Services } from './language-server/__PROJECT_ID__-module.js';

export function createServices(): ReturnType<typeof create__NAME__Services> {
   return create__NAME__Services({ ...NodeFileSystem });
}
`;

const AST = `// The language's AST entry point: a re-export of what \`langium generate\`
// emits, plus anywhere you augment those types.
//
// Import the AST from HERE rather than from \`./generated/ast.js\`, so any
// augmentation below travels with every import. One \`langium-cli\` run over N
// grammars emits ONE combined AST module sharing one reflection, so a further
// grammar needs no change here.
//
// \`generate:transfer-model\` reads this file as its \`--augmentation-file\`: the
// generated wire types are derived from the AST *as augmented*, not from the
// raw generated module. Augment a type here and the transfer model follows.
//
// A \`@derived\` property is computed at build time rather than parsed, so it is
// declared here and populated by an AST-extension contribution:
//
// declare module './generated/ast.js' {
//    interface __ENTRY_RULE__ {
//       /** @derived Populated by an \`ast.extensions.computedProperties\` contribution. */
//       readonly _summary?: string;
//    }
// }

export * from './generated/ast.js';
`;

/**
 * The starter serializer — the concrete-syntax emitter for ONE grammar.
 *
 * Emitted per grammar, not per project, because `services.serializer.Serializer`
 * is a per-language slot and a serializer is grammar-shaped by definition. That
 * is also why the framework refuses to default it: its `UnboundSerializer`
 * throws, naming the binding to add, rather than guessing a syntax.
 */
const SERIALIZER = `// Concrete-syntax emitter for __GRAMMAR__ — the parser's inverse, turning a
// model back into text this grammar accepts. Derived from the starter grammar
// exactly as \`generated/ast.ts\` is, so replacing the grammar replaces this too.
//
// Without it every structured write fails: the framework's default binding at
// \`services.serializer.Serializer\` THROWS, because a concrete syntax is
// language knowledge no framework can derive. \`ModelService.update\` / \`save\`,
// the data head's \`saveModelDocument\` and a GLSP \`SaveModelAction\` all reach
// it.
//
// \`AbstractSerializer\`'s generic property walk lays out FORMAT-structured
// output — its YAML and JSON subclasses are what it exists for — and cannot
// produce a keyword-delimited syntax like \`node a -> b\`. So \`serializeNode\` is
// a per-\`$type\` emitter here and the two array hooks are unreachable.

import { AbstractSerializer } from '@hydranium/core';
import type { AstNode } from '@hydranium/langium';
import { type __ENTRY_RULE__, type __NODE_RULE__, is__ENTRY_RULE__, is__NODE_RULE__ } from './ast.js';

export class __GRAMMAR__Serializer extends AbstractSerializer<__ENTRY_RULE__> {
   protected override serializeNode(node: AstNode | Record<string, unknown>): string {
      if (is__ENTRY_RULE__(node)) {
         return node.nodes.map(child => this.emitNode(child)).join('\\n');
      }
      if (is__NODE_RULE__(node)) {
         return this.emitNode(node);
      }
      // Defensive: a rule added to the grammar with no emitter added here.
      throw new Error(\`__GRAMMAR__Serializer: no emitter for $type \${(node as AstNode).$type}\`);
   }

   /** Unreachable — this grammar's one list is emitted by its \`__ENTRY_RULE__\` parent. */
   protected override serializeArray(): string {
      throw new Error('__GRAMMAR__Serializer: arrays are emitted by the per-$type parent, not the generic dispatch.');
   }

   /** Unreachable — same reasoning as {@link serializeArray}. */
   protected override serializeReferenceArray(): string {
      throw new Error('__GRAMMAR__Serializer: reference arrays are emitted by the per-$type parent, not the generic dispatch.');
   }

   /**
    * \`serializeReferenceText\` rather than \`node.target?.$refText\`: it is the one
    * read that spans BOTH input shapes. A transfer model reaching
    * \`serializeTransfer\` carries \`target\` as a plain string rather than a
    * \`Reference\`, and a serializer that reaches for \`$refText\` directly emits
    * the AST correctly and drops every reference on the transfer path.
    */
   private emitNode(node: __NODE_RULE__): string {
      const target = this.serializeReferenceText(node.target);
      return target === undefined ? \`node \${node.name}\` : \`node \${node.name} -> \${target}\`;
   }
}
`;

/**
 * The exported constant names for the head set, in emission order. Both are
 * keyed by the PROJECT rather than by a language: one server of each kind per
 * process serves every registered grammar, so a language-derived name would tie
 * a project-level endpoint to whichever grammar was scaffolded first.
 */
function portCommandNames(composition: InitComposition): string[] {
   const upper = screamingSnake(composition.projectId);
   return [
      ...(composition.heads.includes('data') ? [`${upper}_DATA_SERVER_PORT_COMMAND`] : []),
      ...(composition.heads.includes('glsp') ? [`${upper}_GLSP_PORT_COMMAND`] : [])
   ];
}

/**
 * The socket heads' discovery commands, as an importable module.
 *
 * Deliberately NOT declared in `main.ts`. A host shell has to name the same
 * string to reach the head, and `main.ts` opens a connection at module scope,
 * so importing a constant from it would start a server. A host that retypes the
 * literal instead gets no error when it drifts: the framework's port poll
 * defaults to `findPortAttempts = -1`, so a wrong command retries forever
 * rather than failing.
 */
function headPortsFile(composition: InitComposition): string {
   const upper = screamingSnake(composition.projectId);
   const data = composition.heads.includes('data');
   const glsp = composition.heads.includes('glsp');
   const blocks = [
      ...(data
         ? [
              `/** LSP request the host queries to discover the data-server socket port. */\nexport const ${upper}_DATA_SERVER_PORT_COMMAND = '${composition.projectId}/data-server/port';`
           ]
         : []),
      ...(glsp
         ? [
              `/** LSP request the host queries to discover the GLSP socket port. */\nexport const ${upper}_GLSP_PORT_COMMAND = '${composition.projectId}/glsp/port';`
           ]
         : [])
   ];
   return `// The LSP requests a host queries to discover this server's socket head${blocks.length > 1 ? 's' : ''}.
//
// Both are keyed by the PROJECT, not the language: one server of each kind per
// process serves every registered grammar, so a language-derived name would tie
// a project-level endpoint to whichever grammar was scaffolded first.
//
// They live here rather than in \`main.ts\` because a host shell has to name the
// same string to reach the head, and \`main.ts\` is an executable entry — nothing
// can import from it. A shell that retypes the literal gets no error when it
// drifts: the framework's port poll retries indefinitely by default. Import
// these instead, and assert any host-side copy against them.

${blocks.join('\n\n')}
`;
}

const INDEX = `// Public surface of the __NAME__ language server: the DI factory, the generated
// AST, and the headless \`createServices\` entry.
//
// The entry points under \`src/\` are deliberately NOT re-exported. Each opens a
// transport at module scope, so importing one starts a server as a side effect
// — which is why they are \`bin\` targets and this file is \`main\`.

export * from './language-server/__PROJECT_ID__-module.js';
export * from './language-server/ast.js';
export { createServices } from './services.js';
`;

/**
 * The public surface, plus the head-port commands when there is a socket head.
 *
 * The commands belong here rather than only in `head-ports.ts` so a host shell
 * reaches them from the package root, the same way it reaches `createServices`.
 */
function indexFile(composition: InitComposition): string {
   const base = project(INDEX, composition);
   return portCommandNames(composition).length ? `${base}export * from './head-ports.js';\n` : base;
}

/**
 * The `#!` line every emitted `bin` target carries.
 *
 * Required in the SOURCE, not added at publish time: npm's install-time `fixBin`
 * sets the exec bit on a linked `bin` target but writes no interpreter line, so
 * an entry whose first line is the SPDX header is handed to `/bin/sh`, which
 * tries to execute the licence comment. `tsc` carries a leading shebang through
 * to `lib/` unchanged, so emitting it here is what makes the linked binary
 * runnable — and it must stay the FIRST line, ahead of the header a licence
 * sweep adds below it.
 */
const SHEBANG = '#!/usr/bin/env node\n';

/**
 * The launcher, assembled from the head set.
 *
 * Every head runs in the same process over ONE `createXxxServices` call, which
 * is what "three heads over one workspace" means: they share the model store,
 * the index and the build pipeline rather than each parsing their own copy.
 *
 * The data head's root type is the union of every grammar's transfer root, which
 * is what one data server serving N grammars means.
 */
function mainFile(composition: InitComposition): string {
   const columns = columnsFor(composition);
   const roots = [...composition.grammars.map(grammar => grammar.entryRule)].sort();
   const upper = screamingSnake(composition.projectId);
   const data = composition.heads.includes('data');
   const glsp = composition.heads.includes('glsp');
   const diagrams = composition.grammars.filter(grammar => grammar.diagram);
   const plural = roots.length > 1 ? 's' : '';

   const headNames = composition.heads.map(head =>
      head === 'lsp' ? 'the Langium LSP head' : head === 'data' ? 'a socket data-server (model server) head' : 'a GLSP head'
   );
   // Comma-joined but for the last, which takes `and`: a bare `, ` join reads as
   // a truncated list, and the emitted comment is the first thing an adopter
   // reads in the file they run.
   const headSummary =
      headNames.length === 1 ? headNames[0] : `${headNames.slice(0, -1).join(', ')} and ${headNames[headNames.length - 1]}`;

   // `reflect-metadata` must be imported before anything that reads a
   // decorator's emitted metadata, which inversify does at module scope.
   const reflectImport = glsp ? "import 'reflect-metadata';\n" : '';
   const coreNodeSymbols = ['NodeFileSystem', ...(data ? ['publishPortOnLspConnection', 'startSocketServer'] : [])];
   const glspImports = glsp
      ? `import { ServerModule } from '@eclipse-glsp/server/node.js';
import { GlspClientLogger, HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { startGlspServer } from '@hydranium/glsp-server/node';
`
      : '';
   const diagramImports = diagrams
      .map(grammar => `import { ${grammar.grammar}DiagramModule } from './glsp/${grammar.grammarId}/diagram-module.js';\n`)
      .join('');
   const transferImports = data
      ? `// The TRANSFER root${plural}, not the AST one${plural}. The data head serialises to the
// persisted shape, where \`Reference<T>\` is a plain \`string\`; the AST's is a
// Langium reference object with \`.ref\` / \`.$refText\`. Both satisfy
// \`TransferElement\` structurally, so naming the AST type here compiles fine and
// silently tells every typed client that a reference is a resolvable object
// rather than a name.
${importList(roots, './language-server/generated-hydranium/transfer-model.js', columns, true)}
`
      : '';

   // The commands live in `head-ports.ts`, not here: a host shell has to name
   // the same string to reach the head, and this file is an executable entry, so
   // nothing can import from it.
   const portCommands = portCommandNames(composition).length
      ? importList(portCommandNames(composition), './head-ports.js', columns) + '\n'
      : '';

   const dataBlock = data
      ? `
// Data-server head alongside LSP: binds an ephemeral port, published over the LSP
// connection for the host to discover. Each accepted client gets its own DataServer.
//
// Neither the bind nor the publish may be swallowed: either failure leaves the LSP
// head serving text edits while every data client waits on a port command that was
// never registered, and the launcher reports a bind failure only if given a logger.
const dataServer = startSocketServer({ port: 0, logTag: 'ModelServer', logger: shared.Logger }, dataConnection => {
   new DataServer<${roots.join(' | ')}>(dataConnection, shared);
   return { dispose: () => undefined };
});
dataServer.started
   .then(() => {
      const { port } = dataServer;
      if (port === undefined) {
         // \`started\` resolves only once the address is resolved, so this is
         // unreachable; a non-null assertion in its place would publish
         // \`undefined\`, which the host cannot tell from an unreachable port.
         throw new Error('the data head started without a resolved port');
      }
      publishPortOnLspConnection(shared.lsp.Connection, ${upper}_DATA_SERVER_PORT_COMMAND, port);
   })
   .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      shared.Logger.error(\`[ModelServer] Could not publish the data-server port: \${reason}\`);
   });
`
      : '';

   const glspBlock = glsp
      ? `
// GLSP head on the same shared workspace. \`HydraniumGlspAppModule\` is used
// unsubclassed: the app container is one per process and cannot know which
// grammar a request concerns, so nothing per-language belongs there — each
// diagram module declares its own language instead.
//
// GLSP framework logs route through the LSP connection rather than stdout, which
// IS the LSP transport in stdio mode; writing there corrupts the protocol stream.
const glspServer = startGlspServer({
   // The GLSP log threshold lives on the logger, not beside it: the framework
   // replaces GLSP's own \`Logger\` binding, so a launcher-level \`logLevel\` would
   // be discarded. The logger tracks the framework's process-wide threshold, so
   // \`HYDRANIUM_LOG_LEVEL\` and the LSP log-level setting govern GLSP output too;
   // pass \`logLevel\` only to make GLSP quieter than the rest of the server.
   createLogger: caller => new GlspClientLogger(shared, { component: caller }),
   serverModule: new ServerModule()${diagrams.map(grammar => `.configureDiagramModule(new ${grammar.grammar}DiagramModule())`).join('')},
   appModules: [new HydraniumGlspAppModule({ shared })],
   lspConnection: shared.lsp.Connection,
   portCommand: ${upper}_GLSP_PORT_COMMAND
});
void glspServer;
`
      : '';

   const text = `${SHEBANG}// Standalone entry point: starts ${headSummary} in the same
// process, so every head shares one model store.
// Invocation: \`node lib/main.js --stdio\`, or the package's \`__PROJECT_ID__\` bin
// script.${
      data
         ? `
//
// NOT the entry \`hydranium-cli query\` / \`save\` / \`projects\` / \`watch\` speak to:
// stdio here carries LSP, and the data head is a socket whose port is published
// over the LSP connection. Those subcommands spawn \`data-server-main.js\`.`
         : ''
   }
//
// Everything here runs at module scope, so this file is an executable rather
// than a library entry — import \`./index.js\` instead to compose the language.

${reflectImport}${glspImports}${importList(coreNodeSymbols, '@hydranium/core/node', columns)}
${data ? "import { DataServer } from '@hydranium/data-server';\n" : ''}import { startLanguageServer } from '@hydranium/langium/lsp';
import { ProposedFeatures, createConnection } from 'vscode-languageserver/node';
${diagramImports}${transferImports}import { create__NAME__Services } from './language-server/__PROJECT_ID__-module.js';
${portCommands === '' ? '' : '\n' + portCommands}
const connection = createConnection(ProposedFeatures.all);
const { shared } = create__NAME__Services({ connection, ...NodeFileSystem });
startLanguageServer(shared);
${dataBlock}${glspBlock}`;
   return project(text, composition);
}

/**
 * The second executable entry: the data head alone, on stdio.
 *
 * Emitted with the `data` head because it is the ONLY command line that reaches
 * that head from outside the editor. `main.ts` gives stdio to LSP and publishes
 * the data head's socket port over the LSP connection, so a client that is not
 * an LSP client cannot discover it — which is every one of `hydranium-cli`'s
 * `query` / `save` / `projects` / `watch`, all of which drive the data protocol
 * over a spawned child's stdin/stdout. Without this file a scaffolded project
 * has no `--server` value, and the closest guess — the LSP entry — fails as an
 * unrecognised method rather than as a missing head.
 *
 * A separate process rather than a flag on `main.ts`: only one protocol can own
 * stdio, so the two entries are mutually exclusive by construction.
 */
function dataServerMainFile(composition: InitComposition): string {
   const columns = columnsFor(composition);
   const roots = [...composition.grammars.map(grammar => grammar.entryRule)].sort();
   const plural = roots.length > 1 ? 's' : '';

   const text = `${SHEBANG}// Standalone entry point: a data-server head on **stdio**, with no LSP head in
// the process. This is the transport \`hydranium-cli\` speaks — \`query\`, \`save\`,
// \`projects\` and \`watch\` all spawn a server command and drive JSON-RPC over its
// stdin/stdout — so it is what makes those subcommands usable against this
// language.
//
// Invocation: \`node lib/data-server-main.js [<workspace-path>]\`, or the
// package's \`__PROJECT_ID__-data-server\` bin script. The workspace path defaults to
// the process cwd, which is what the CLI's \`--cwd\` sets on the child.
//
// Contrast with \`main.ts\`, the editor entry: there the LSP head owns stdio and
// the data head is a socket published over the LSP connection. Here there is no
// LSP connection at all, so the workspace initialization an
// \`initialize\`/\`initialized\` pair would otherwise drive has to happen here —
// which is why this entry uses \`startStdioServer\` rather than wiring a
// connection directly.
//
// Everything here runs at module scope, so this file is an executable rather
// than a library entry — import \`./index.js\` instead to compose the language.

${importList(['NodeFileSystem', 'startStdioServer'], '@hydranium/core/node', columns)}
import { DataServer } from '@hydranium/data-server';
// The TRANSFER root${plural}, not the AST one${plural} — same reasoning as \`main.ts\`.
${importList(roots, './language-server/generated-hydranium/transfer-model.js', columns, true)}
import { create__NAME__Services } from './language-server/__PROJECT_ID__-module.js';

const { shared } = create__NAME__Services({ ...NodeFileSystem });

// \`startStdioServer\` owns the transport AND the workspace bring-up, including
// the ordering between them: a head with no LSP connection never receives
// \`initialize\`/\`initialized\`, and initialization has to complete before the
// reader is attached or a request arriving during startup races an unpopulated
// project registry. The launcher exists so no adopter has to re-derive that
// ordering by hand.
const server = startStdioServer(
   {
      shared,
      // Defaults to the process cwd, which is what the CLI's \`--cwd\` sets on the
      // spawned child; an explicit path argument overrides it.
      workspace: process.argv[2] ?? process.cwd(),
      logger: shared.Logger,
      logTag: 'ModelServer'
   },
   connection => {
      new DataServer<${roots.join(' | ')}>(connection, shared);
      // The DataServer self-cleans via \`connection.onClose\`, so there is nothing
      // extra to tear down here.
      return { dispose: () => undefined };
   }
);

// Surfaces a failed bring-up as a non-zero exit instead of a silent, listening
// head that would answer against an empty workspace.
server.started.catch(() => process.exit(1));
`;
   return project(text, composition);
}

/** The scaffold's first test: the DI tree composes and every language is registered. */
function servicesTest(composition: InitComposition): string {
   const ids = composition.grammars.map(grammar => grammar.languageId);
   const extensions = composition.grammars.flatMap(grammar => grammar.extensions.map(extension => `.${extension}`));
   const title = ids.length === 1 ? 'exactly one language' : `all ${ids.length} languages`;
   const text = `// The scaffold's first test: the DI tree composes and every language is
// registered. Deliberately grammar-agnostic, so it keeps passing once you
// replace the starter grammar with your own.
//
// \`createServices()\` not throwing is itself an assertion — the framework's
// \`assertCoreSlotsBound\` runs during bootstrap and fails loudly when a module
// is missing from the composition.

import { describe, expect, it } from 'vitest';
import { createServices } from '../src/services.js';

describe('__NAME__ services', () => {
   it('composes the DI tree and registers ${title}', () => {
      const { shared } = createServices();

      const registered = shared.ServiceRegistry.all.map(language => language.LanguageMetaData);
      expect(registered.map(metadata => metadata.languageId)).toEqual([${quotedList(ids)}]);
      expect(registered.flatMap(metadata => [...metadata.fileExtensions])).toEqual([${quotedList(extensions)}]);
   });

   it('binds a reflection covering the generated AST', () => {
      const { shared } = createServices();

      expect(shared.AstReflection.getAllTypes().length).toBeGreaterThan(0);
   });
});
`;
   return project(text, composition);
}

/**
 * One `describe` per grammar, round-tripping that grammar's serializer.
 *
 * Both directions, because they fail independently: an emitter reaching for
 * `$refText` renders the AST correctly and silently drops every reference on the
 * transfer path, which is the shape the data head hands it.
 */
const SERIALIZATION_SUITE = `describe('__GRAMMAR__ serialization', () => {
   const source = 'node first -> second\\nnode second';

   it('round-trips parsed source back to the same text', async () => {
      const { __GRAMMAR__ } = createServices();

      const document = await parseHelper<__ENTRY_RULE__>(__GRAMMAR__)(source, { documentUri: 'file:///round-trip.__EXTENSION__' });

      expect(document.parseResult.parserErrors).toHaveLength(0);
      expect(await __GRAMMAR__.serializer.Serializer.serializeAst(document.parseResult.value)).toBe(source);
   });

   it('emits the same text from a transfer model, whose references are plain strings', async () => {
      const { __GRAMMAR__ } = createServices();
      const model: Transfer__ENTRY_RULE__ = {
         $type: '__ENTRY_RULE__',
         nodes: [
            { $type: '__NODE_RULE__', name: 'first', target: 'second' },
            { $type: '__NODE_RULE__', name: 'second' }
         ]
      };

      expect(await __GRAMMAR__.serializer.Serializer.serializeTransfer(model)).toBe(source);
   });
});`;

/**
 * The serializer round-trip test, one suite per grammar.
 *
 * Grammar-DERIVED, unlike `services.test.ts` next to it: it names the starter
 * rules and the syntax they spell, so replacing the grammar replaces this file
 * along with the serializer it covers. That is the same bargain
 * `gmodel-factory.ts` makes, and the reason it is worth making here is that
 * nothing else executes the serializer — the golden pins its bytes and `tsc`
 * pins its types, and neither can see a wrong emission.
 */
function serializationTest(composition: InitComposition): string {
   const columns = columnsFor(composition);
   const astTypes = composition.grammars.map(grammar => grammar.entryRule);
   const transferTypes = composition.grammars.map(grammar => `${grammar.entryRule} as Transfer${grammar.entryRule}`);
   const text = `// Round-trips each grammar through its serializer: parse the source, serialize
// the model, compare the text. The serializer is the parser's inverse, so this
// is the assertion that keeps \`ModelService.update\` / \`save\` writing files the
// language server can read back.
//
// The transfer case is the one that catches the mistake worth catching.
// \`ModelService.modelToText\` short-circuits only a RAW STRING, so a typed model
// from the data head reaches \`serializeTransfer\` — where a cross-reference is a
// plain string, not a \`Reference\`.

import { parseHelper } from '@hydranium/core/testing';
import { describe, expect, it } from 'vitest';
${importList(astTypes, '../src/language-server/ast.js', columns, true)}
${importList(transferTypes, '../src/language-server/generated-hydranium/transfer-model.js', columns, true)}
import { createServices } from '../src/services.js';

${composition.grammars.map(grammar => render(SERIALIZATION_SUITE, composition, grammar)).join('\n\n')}
`;
   return text;
}

/**
 * The three tiers `generator-langium` scaffolds, in the order a new adopter
 * breaks them: does my rule parse, does my cross-reference resolve, does a
 * broken one get reported.
 *
 * Each is grammar-derived and each keeps working in SHAPE once the starter
 * grammar is replaced, which is the same bargain `services.test.ts` makes from
 * the other direction — that one stays grammar-agnostic and asserts nothing
 * about the language.
 */
const PARSING_SUITE = `describe('__GRAMMAR__ parsing', () => {
   it('parses the starter rules and populates the AST', async () => {
      const { __GRAMMAR__ } = createServices();

      const document = await parseHelper<__ENTRY_RULE__>(__GRAMMAR__)('node first -> second\\nnode second', {
         documentUri: 'file:///parsing.__EXTENSION__'
      });

      expect(document.parseResult.lexerErrors).toHaveLength(0);
      expect(document.parseResult.parserErrors).toHaveLength(0);
      expect(document.parseResult.value.nodes.map(node => node.name)).toEqual(['first', 'second']);
   });

   it('reports a parser error for text the grammar does not accept', async () => {
      const { __GRAMMAR__ } = createServices();

      // The name is mandatory, so this is a parse failure rather than a
      // validation one — nothing downstream of the parser runs on it.
      const document = await parseHelper<__ENTRY_RULE__>(__GRAMMAR__)('node -> second', {
         documentUri: 'file:///invalid.__EXTENSION__'
      });

      expect(document.parseResult.parserErrors.length).toBeGreaterThan(0);
   });
});`;

/**
 * Both directions of linking, and the CROSS-document one is the half that
 * matters: a same-document reference resolves through the local scope and would
 * still pass with the global index empty.
 *
 * `DocumentBuilder.build` rather than `parseHelper`'s `validation` option
 * because linking is what is under test, and a build over BOTH documents is
 * what puts the first one's exports in the index the second one reads.
 */
const LINKING_SUITE = `describe('__GRAMMAR__ linking', () => {
   it('resolves a reference within one document', async () => {
      const { shared, __GRAMMAR__ } = createServices();

      const document = await parseHelper<__ENTRY_RULE__>(__GRAMMAR__)('node first -> second\\nnode second', {
         documentUri: 'file:///within.__EXTENSION__'
      });
      await shared.workspace.DocumentBuilder.build([document]);

      expect(document.parseResult.value.nodes[0].target?.ref?.name).toBe('second');
   });

   it('resolves a reference across documents, through the shared index', async () => {
      const { shared, __GRAMMAR__ } = createServices();
      const parse = parseHelper<__ENTRY_RULE__>(__GRAMMAR__);

      const declaring = await parse('node second', { documentUri: 'file:///declaring.__EXTENSION__' });
      const referencing = await parse('node first -> second', { documentUri: 'file:///referencing.__EXTENSION__' });
      await shared.workspace.DocumentBuilder.build([declaring, referencing]);

      // The URI, not just the name: the referencing document declares no
      // \`second\` of its own, but asserting WHERE the target came from is what
      // keeps this about the global index rather than about local scope.
      const target = referencing.parseResult.value.nodes[0].target?.ref;
      expect(target?.name).toBe('second');
      expect(target ? AstUtils.getDocument(target).uri.toString() : undefined).toBe('file:///declaring.__EXTENSION__');
   });
});`;

/**
 * The validation tier, asserting the FRAMEWORK's diagnostics rather than an
 * adopter rule.
 *
 * The scaffold binds no `validation.checks`, so a test over an adopter check
 * would have to invent one and would then assert the test's own fixture rather
 * than the language. What a scaffolded project really guarantees on day one is
 * that a dangling reference is reported, which is a linker diagnostic — and
 * that is the tier a new adopter breaks third.
 */
const VALIDATING_SUITE = `describe('__GRAMMAR__ validation', () => {
   it('reports nothing for a well-formed document', async () => {
      const { shared, __GRAMMAR__ } = createServices();

      const document = await parseHelper<__ENTRY_RULE__>(__GRAMMAR__)('node first -> second\\nnode second', {
         documentUri: 'file:///valid.__EXTENSION__'
      });
      await shared.workspace.DocumentBuilder.build([document], { validation: true });

      expect(document.diagnostics ?? []).toHaveLength(0);
   });

   it('reports an error for a reference that resolves to nothing', async () => {
      const { shared, __GRAMMAR__ } = createServices();

      const document = await parseHelper<__ENTRY_RULE__>(__GRAMMAR__)('node first -> absent', {
         documentUri: 'file:///dangling.__EXTENSION__'
      });
      await shared.workspace.DocumentBuilder.build([document], { validation: true });

      const diagnostics = document.diagnostics ?? [];
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].severity).toBe(DiagnosticSeverity.Error);
      expect(diagnostics[0].message).toContain('absent');
   });
});`;

/** Assemble one grammar-derived test file: a fixed preamble plus one suite per grammar. */
function grammarTest(composition: InitComposition, header: string, imports: readonly string[], suite: string): string {
   const columns = columnsFor(composition);
   const astTypes = composition.grammars.map(grammar => grammar.entryRule);
   return `${header}

import { parseHelper } from '@hydranium/core/testing';
import { describe, expect, it } from 'vitest';
${imports.join('\n')}${imports.length ? '\n' : ''}${importList(astTypes, '../src/language-server/ast.js', columns, true)}
import { createServices } from '../src/services.js';

${composition.grammars.map(grammar => render(suite, composition, grammar)).join('\n\n')}
`;
}

const PARSING_HEADER = `// Tier one of the three a new language breaks in order: does my rule parse.
//
// Grammar-derived, so replacing the starter grammar replaces this file — but
// the SHAPE survives, which is the point of scaffolding it: the questions stay
// the same for every language, only the source text changes.`;

const LINKING_HEADER = `// Tier two: does my cross-reference resolve.
//
// Both cases matter and they fail for different reasons. A same-document
// reference resolves through local scope alone; a cross-document one needs the
// declaring document's exports in the shared global index, which is what a
// multi-file workspace depends on and what a single-document test cannot see.`;

const VALIDATING_HEADER = `// Tier three: does a broken model get reported.
//
// These are the FRAMEWORK's own linker diagnostics, not adopter checks — the
// scaffold binds no \`validation.checks\`, and a test over an invented one would
// assert its own fixture rather than the language. Bind a check in your
// language module and assert it here alongside these.`;

/** The README, assembled from lines to avoid escaping the Markdown code fences. */
function readme(composition: InitComposition): string {
   const multi = composition.grammars.length > 1;
   const data = composition.heads.includes('data');
   const primaryExtension = composition.grammars[0].extensions[0];
   const grammarBullets = composition.grammars.map(
      grammar => `- \`src/grammar/${grammar.grammarId}.langium\` — the \`${grammar.grammar}\` grammar (.${grammar.extensions.join(', .')})`
   );
   const lines = [
      '# __NAME__',
      '',
      'A Hydranium language project scaffolded by `hydranium-cli init`.',
      '',
      '## Getting started',
      '',
      // Conditional on the pin this scaffold actually carries — see
      // `UNPUBLISHED_FRAMEWORK_VERSION`.
      ...(composition.frameworkVersion === UNPUBLISHED_FRAMEWORK_VERSION
         ? [
              '> **Pre-publish note.** `@hydranium/*` is not on npm yet, so the `0.0.0`',
              '> pins below are placeholders and `npm install` will fail with a 404 until',
              '> the framework is released. Until then, supply the packages from a local',
              '> framework checkout with [yalc](https://github.com/wclr/yalc) — a plain',
              '> `file:` path or `npm link` is not enough, because the framework packages',
              '> depend on each other by version and npm would try to fetch those from the',
              '> registry too.',
              ''
           ]
         : []),
      '```bash',
      'npm install',
      'npm run langium:generate   # generate the AST from the grammar',
      'npm run build              # generate + compile to lib/',
      'npm test                   # typecheck the tests, then run them',
      '```',
      '',
      '## Try the framework CLI against it',
      '',
      // `npx`, not a bare invocation: `@hydranium/cli` is a devDependency of the
      // emitted project, so the binary is on PATH inside an npm script and
      // nowhere else.
      '```bash',
      '# Grammar / AST reflection',
      'npx hydranium-cli reflect --services ./lib/services.js',
      '',
      '# Grammar-convention lint (CI gate)',
      'npx hydranium-cli lint-grammar --services ./lib/services.js',
      '',
      '# Validate a workspace of model files (non-zero exit on errors)',
      'npx hydranium-cli validate --services ./lib/services.js <workspace-dir>',
      ...(data
         ? [
              '',
              '# Data-head operations. `--server` is a command line the CLI spawns and then',
              "# drives the data protocol over the child's stdin/stdout, so it has to name",
              '# `data-server-main.js` — `main.js` gives stdio to LSP and answers these',
              '# methods with "Unhandled method".',
              '#',
              '# The workspace goes to the ENTRY, not to `--cwd`: `--cwd` re-roots the child,',
              '# so a relative entry path is refused by name (an absolute one is fine).',
              'npx hydranium-cli projects --server "node ./lib/data-server-main.js <workspace-dir>"',
              `npx hydranium-cli query --server "node ./lib/data-server-main.js <workspace-dir>" --uri <file:// URI of a .${primaryExtension} file>`
           ]
         : []),
      '```',
      '',
      '## Layout',
      '',
      ...grammarBullets,
      ...(multi ? ['- `src/grammar/common.langium` — shared terminals, imported by each grammar (not a language)'] : []),
      '- `src/language-server/__PROJECT_ID__-module.ts` — `create__NAME__Services` DI wiring',
      ...composition.grammars.map(
         grammar =>
            `- \`src/language-server/${grammar.grammarId}-serializer.ts\` — emits \`${grammar.grammar}\` back to text (the framework defaults this to a throw)`
      ),
      '- `src/services.ts` — zero-arg `createServices()` for the headless CLI',
      '- `src/index.ts` — the package entry (`main`): DI factory + generated AST',
      `- \`src/main.ts\` — starts ${composition.heads.join(' + ')}, the \`__PROJECT_ID__\` bin entry`,
      ...(data
         ? [
              '- `src/data-server-main.ts` — the data head alone on stdio, the',
              '  `__PROJECT_ID__-data-server` bin entry and the `--server` value the CLI needs'
           ]
         : []),
      ...composition.grammars
         .filter(grammar => grammar.diagram)
         .map(
            grammar =>
               `- \`src/glsp/${grammar.grammarId}/\` — the \`${grammar.grammar}\` diagram: type ids, state, storage, submission handler, GModel factory, configuration, create-node handler, DI module`
         ),
      '- `test/services.test.ts` — the DI tree composes; grows as your language does',
      '- `test/parsing.test.ts` / `linking.test.ts` / `validating.test.ts` — the three tiers a new language breaks first',
      '- `test/serialization.test.ts` — each grammar round-trips through its serializer',
      '- `syntaxes/` — generated TextMate grammar for a VS Code extension (gitignored)',
      '',
      ...(data
         ? ['The two entry points are `bin` scripts rather than `main` on purpose:']
         : ['`main.ts` is a `bin` script rather than `main` on purpose:']),
      'each opens a transport at module scope, so importing one would start a',
      'server as a side effect. Compose the language through `src/index.ts` instead.',
      '',
      '## Three names, and when they diverge',
      '',
      ...(multi
         ? [
              'This project holds several grammars, so the tiers have already diverged:',
              'the project name is the umbrella and each grammar names its own language.'
           ]
         : [
              'The scaffold sets all three to the same value, which is right for one',
              'grammar and stops being right the moment you add a second:'
           ]),
      '',
      '| Name | Set by | Generates |',
      '| --- | --- | --- |',
      '| project | `--name` / `projectName` | `__NAME__AstReflection`, `__NAME__GeneratedSharedModule` — one set per project |',
      '| grammar | `--grammar` / `grammar X` | `<Grammar>GeneratedModule`, `<Grammar>LanguageMetaData` — one set per grammar |',
      '| language id | derived, or `--language-id` | file routing, the `langium-config` entry id |',
      '',
      'A further grammar is another `--grammar` (or another entry in',
      '`langium-config.json` — never a second config file, because `AstReflection`',
      'is one shared slot) with its own grammar name, while the project name stays',
      'the umbrella.',
      '',
      'Each grammar declares its own entry rule (`<Grammar>Model`) rather than a',
      'shared `Model`, because one `langium-cli` run over N grammars emits one',
      'combined `ast.ts` and two `Model` interfaces would collide in it.',
      '',
      ...(multi
         ? [
              'The scaffolded grammars are independent — each imports `common.langium`',
              'for its terminals and nothing else. Which grammar may reference which is',
              'a modelling decision, so add an `import` between them when you know the',
              'direction, and remember that references point one way.',
              ''
           ]
         : []),
      'The `langium` / `langium-cli` versions are pinned exactly rather than',
      'ranged: the framework treats `langium` and its `vscode-*` chain as one',
      'atomic set and depends on a single physical copy, so a floating range can',
      'silently resolve a second one.',
      '',
      '## If your repo gates license headers',
      '',
      'The emitted `.ts` files carry no copyright header — the scaffold cannot know',
      'your license. Run your own header tool over `src/` and `test/` after',
      'scaffolding. The file-purpose comments are `//` runs rather than `/** */`',
      'blocks precisely so that a tool which REPLACES the leading block comment',
      'does not silently delete them.',
      '',
      `The ${data ? 'two `bin` entries' : '`bin` entry'} start with a \`#!\` line, and it has to STAY the first`,
      'line: a header tool that prepends unconditionally leaves the shell reading',
      'the license comment as a script, which is what a linked binary then runs.',
      ''
   ];
   return project(lines.join('\n'), composition);
}

/**
 * The GLSP files for ONE grammar's diagram.
 *
 * Per grammar rather than per project because a diagram type has exactly one
 * grammar — `AbstractHydraniumGlspDiagramModule.declareLanguage()` returns that
 * grammar's `LanguageMetaData`, and it is bound on the SESSION container so a
 * grammar with no diagram can sit on the same server.
 *
 * The index and the computed-bounds handler are framework classes used
 * unmodified; storage and the submission handler are thin typed subclasses,
 * which is where an adopter's own load/save and log formatting land.
 *
 * The set is EDITABLE rather than read-only: one create-node handler, registered
 * on the module. GLSP's own `DiagramModule` binds no handler that mutates a
 * source model, so without it the head renders and answers while telling the
 * client it may change nothing — which reads as a broken diagram rather than as a
 * deliberate viewer.
 */
function glspFiles(composition: InitComposition, grammar: InitGrammarNames): InitFile[] {
   const columns = columnsFor(composition);
   const upper = screamingSnake(grammar.grammarId);
   const dir = `src/glsp/${grammar.grammarId}`;
   const render = (text: string): string => grammarTier(project(text, composition), grammar);

   const types = `// GLSP diagram-type and element-type ids for the __GRAMMAR__ diagram.
//
// **Authoritative half of a client/server contract.** Every id here has to be
// registered on the client too: sprotty's registries are exact-key maps with no
// prefix fallback, so an id the client does not know yields an element with none
// of a node's features, rendered by \`MissingView\` with only a
// \`no registered view for type '…'\` console warning. Nothing fails server-side.
//
// The ids stay namespaced under the GLSP defaults (\`node:\` / \`edge:\`) so a
// reader can tell a node id from an edge id at a glance.

import { DefaultTypes } from '@eclipse-glsp/server';

/**
 * The GLSP diagram type — the string GLSP routes every per-diagram-type request
 * by. Mirrored by the client; a mismatch silently DROPS the request rather than
 * reporting an unknown diagram type. Same value as the language id, so the two
 * cannot drift apart as a diagram gains element types.
 */
export const ${upper}_DIAGRAM_TYPE = '__LANGUAGE_ID__';

/** A \`__NODE_RULE__\` — the starter grammar's one named, referenceable node. */
export const ${upper}_NODE_TYPE = \`\${DefaultTypes.NODE}:__GRAMMAR_ID__-node\`;

/** A resolved \`target\` reference, drawn as a connection between two nodes. */
export const ${upper}_EDGE_TYPE = \`\${DefaultTypes.EDGE}:__GRAMMAR_ID__-target\`;
`;

   const state = `// GLSP state for the __GRAMMAR__ diagram.
//
// \`FullTextHydraniumGlspState\` is the simplest of the framework source-model
// strategies (the others project a structured transfer model, over one document
// or several): the source model is the whole document text, serialised through
// the per-URI \`Serializer\` and round-tripped by re-parsing. Both seams resolve
// through shared services, so narrowing the root type is all an adopter adds.
//
// It cannot field-merge — every concurrent edit on a whole-document model is a
// same-document collision, so undo / redo degrade to drop-on-divergence. Move to
// \`ReconcilingTransferHydraniumGlspState\` when you need field-level undo.

import { FullTextHydraniumGlspState } from '@hydranium/glsp-server';
import { injectable } from 'inversify';
import type { __ENTRY_RULE__ } from '../../language-server/ast.js';

@injectable()
export class __GRAMMAR__GlspState extends FullTextHydraniumGlspState<__ENTRY_RULE__> {}
`;

   const storage = `// Source-model storage for the __GRAMMAR__ diagram, inheriting both framework
// defaults: \`loadSourceModel\` (open + settle + \`setSourceRoot\`) and
// \`saveSourceModel\` (through \`ModelService.save\` → the per-URI \`Serializer\` →
// the multi-client text store → \`WritableFileSystemProvider\`).
//
// The subclass exists so a bespoke load or save has a stable place to land.

import { type FullTextSourceModel, HydraniumGlspStorage } from '@hydranium/glsp-server';
import { injectable } from 'inversify';
import type { __ENTRY_RULE__ } from '../../language-server/ast.js';

@injectable()
export class __GRAMMAR__GlspStorage extends HydraniumGlspStorage<__ENTRY_RULE__, FullTextSourceModel> {}
`;

   const submission = `// Submission handler for the __GRAMMAR__ diagram.
//
// Inherits the framework's \`readyEvent = IntegrityService.SettledState\`, which
// is load-bearing rather than incidental: the GModel factory resolves
// \`target.ref\`, so it needs a fully-linked AST. Without the gate those reads
// fire mid-build and warn about resolution before scopes are computed.
//
// Only \`formatSourceRoot\` is overridden, so the submit log names the model and
// its node count instead of a bare \`$type\`.

import { ModelState } from '@eclipse-glsp/server';
import { type FullTextSourceModel, HydraniumGlspSubmissionHandler } from '@hydranium/glsp-server';
import { inject, injectable } from 'inversify';
import type { __ENTRY_RULE__ } from '../../language-server/ast.js';
import type { __GRAMMAR__GlspState } from './state.js';

@injectable()
export class __GRAMMAR__SubmissionHandler extends HydraniumGlspSubmissionHandler<__ENTRY_RULE__, FullTextSourceModel> {
   @inject(ModelState) declare protected modelState: __GRAMMAR__GlspState;

   protected override formatSourceRoot(root: __ENTRY_RULE__ | undefined): string {
      return root ? \`__ENTRY_RULE__ nodes=\${root.nodes.length}\` : 'none';
   }
}
`;

   const factory = `// AST → GModel for the __GRAMMAR__ diagram: one node per \`__NODE_RULE__\`, one
// edge per resolved \`target\` reference.
//
// Ids come from the index rather than being composed here, so the id strategy
// stays in one place. Nodes are emitted before edges, because a GLSP edge
// pointing at an id that does not exist fails client-side with a far less
// obvious error than a missing edge. An unresolved reference is SKIPPED rather
// than treated as an error: a dangling reference is ordinary editing state, and
// the LSP head already reports it as a diagnostic.

import { DefaultTypes, GEdge, GGraph, GLabel, type GModelFactory, GNode, ModelState } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import type { __ENTRY_RULE__ } from '../../language-server/ast.js';
import { ${upper}_EDGE_TYPE, ${upper}_NODE_TYPE } from './types.js';
import type { __GRAMMAR__GlspState } from './state.js';

@injectable()
export class __GRAMMAR__GModelFactory implements GModelFactory {
   @inject(ModelState) protected readonly modelState!: __GRAMMAR__GlspState;

   createModel(): void {
      const root = this.modelState.sourceRoot;
      const graph = GGraph.builder().id(this.modelState.sourceUri).build();
      if (root) {
         this.buildGraph(root, graph);
      }
      this.modelState.updateRoot(graph);
   }

   protected buildGraph(root: __ENTRY_RULE__, graph: GGraph): void {
      for (const node of root.nodes) {
         const id = this.modelState.index.createId(node);
         graph.children.push(
            GNode.builder()
               .id(id)
               .type(${upper}_NODE_TYPE)
               .add(GLabel.builder().id(\`\${id}_name\`).text(node.name).type(DefaultTypes.LABEL).build())
               .build()
         );
      }
      for (const node of root.nodes) {
         const target = node.target?.ref;
         if (!target) {
            continue;
         }
         const sourceId = this.modelState.index.createId(node);
         graph.children.push(
            GEdge.builder()
               .id(\`\${sourceId}_target\`)
               .type(${upper}_EDGE_TYPE)
               .sourceId(sourceId)
               .targetId(this.modelState.index.createId(target))
               .build()
         );
      }
   }
}
`;

   const configuration = `// Diagram configuration for the __GRAMMAR__ diagram.
//
// **Every hint is \`false\`, and that is not the same as read-only.** The starter
// __GRAMMAR__CreateNodeOperationHandler makes this diagram editable through the
// tool palette, which GLSP assembles from the create handlers' trigger actions —
// there is no \`creatable\` hint. What the hints govern is delete / reparent /
// reposition / resize, and nothing backs those, so declaring one would offer a
// gesture whose operation the server rejects: a worse failure than the tool being
// absent. Turn a hint on in the same change that adds its handler.
//
// \`needsClientLayout\` is \`true\` and \`layoutKind\` is \`NONE\`: the starter grammar
// persists no bounds, so the client measures and places everything. That is also
// why \`ChangeBoundsOperation\` is a poor second handler to add — with nowhere in
// the grammar to write a position, a move never reaches the text and is lost on
// the next reload.

import { type GModelElementConstructor } from '@eclipse-glsp/graph';
${importList(
   ['type DiagramConfiguration', 'type EdgeTypeHint', 'ServerLayoutKind', 'type ShapeTypeHint', 'getDefaultMapping'],
   '@eclipse-glsp/server',
   columns
)}
import { injectable } from 'inversify';
import { ${upper}_EDGE_TYPE, ${upper}_NODE_TYPE } from './types.js';

@injectable()
export class __GRAMMAR__DiagramConfiguration implements DiagramConfiguration {
   readonly layoutKind: ServerLayoutKind = ServerLayoutKind.NONE;
   readonly needsClientLayout: boolean = true;
   readonly animatedUpdate: boolean = false;

   readonly typeMapping: Map<string, GModelElementConstructor> = getDefaultMapping();

   readonly shapeTypeHints: ShapeTypeHint[] = [
      {
         elementTypeId: ${upper}_NODE_TYPE,
         deletable: false,
         reparentable: false,
         repositionable: false,
         resizable: false
      }
   ];

   readonly edgeTypeHints: EdgeTypeHint[] = [
      {
         elementTypeId: ${upper}_EDGE_TYPE,
         deletable: false,
         repositionable: false,
         routable: false,
         sourceElementTypeIds: [${upper}_NODE_TYPE],
         targetElementTypeIds: [${upper}_NODE_TYPE]
      }
   ];
}
`;

   const createHandler = `// The starter operation handler for the __GRAMMAR__ diagram: the tool-palette
// entry that creates a \`__NODE_RULE__\`.
//
// **Deleting this file and its \`configureOperationHandlers\` registration in
// \`diagram-module.ts\` gives a read-only viewer**, and nothing else has to change
// — creation is offered through the palette rather than through a type hint, so
// every hint in \`diagram-configuration.ts\` is already \`false\`. The scaffold emits
// the editable direction because that asymmetry runs one way: editable →
// read-only is a deletion the compiler checks, while read-only → editable is
// authoring against a seam you have not used yet.
//
// **It composes TEXT rather than mutating the AST.** The source model of
// \`FullTextHydraniumGlspState\` is the document text, and reading it back through
// \`state.sourceModel\` serialises the AST through the per-URI \`Serializer\`, which
// this scaffold does not bind — so that getter throws until you do. Appending a
// declaration to the text the parser last read needs no serializer, which is what
// makes a scaffolded diagram editable on day one. Bind a \`Serializer\` at
// \`services.serializer.Serializer\` and this becomes a
// \`HydraniumGlspRecordingCommand\` over \`state.sourceModel\` instead — the same
// binding the diagram's own save action needs.
//
// **The drop location is discarded.** \`needsClientLayout\` is \`true\` and the
// starter grammar persists no bounds, so there is nowhere to put a coordinate: the
// node is appended at the end of the document and the client places it.
//
// Like \`types.ts\`, \`gmodel-factory.ts\` and \`diagram-configuration.ts\`, this file
// knows the starter grammar's concrete syntax — the \`node\` keyword below is that
// grammar's. Replacing the grammar means replacing these four together.

import { type Command, type CreateNodeOperation, JsonCreateNodeOperationHandler, type MaybePromise } from '@eclipse-glsp/server';
import { findNextUnique } from '@hydranium/protocol';
import { injectable } from 'inversify';
import { ${upper}_NODE_TYPE } from './types.js';
import type { __GRAMMAR__GlspState } from './state.js';

/** Proposed name for a new node, uniquified against the ones the document already has. */
const NODE_NAME_STEM = 'Node';

@injectable()
export class __GRAMMAR__CreateNodeOperationHandler extends JsonCreateNodeOperationHandler {
   declare protected modelState: __GRAMMAR__GlspState;

   /** The palette's word for the thing it creates, so a noun rather than an action. */
   override readonly label = '__NODE_RULE__';
   elementTypeIds = [${upper}_NODE_TYPE];

   override createCommand(operation: CreateNodeOperation): MaybePromise<Command | undefined> {
      if (!this.elementTypeIds.includes(operation.elementTypeId)) {
         return undefined;
      }
      const state = this.modelState;
      const before = this.documentText();
      const after = this.withNode(
         before,
         findNextUnique(
            NODE_NAME_STEM,
            state.sourceRoot.nodes.map(node => node.name)
         )
      );
      // Whole-document undo, which is all a full-text source model can offer: it
      // has exactly one field, so there is nothing to merge a concurrent edit into.
      return {
         execute: () => state.updateSourceModel({ text: after }),
         undo: () => state.updateSourceModel({ text: before }),
         redo: () => state.updateSourceModel({ text: after })
      };
   }

   /** The text the captured source root was parsed from — the baseline an edit appends to. */
   protected documentText(): string {
      return this.modelState.sourceRoot.$document?.textDocument.getText() ?? '';
   }

   /** \`text\` with one more node declaration, under exactly one trailing newline. */
   protected withNode(text: string, name: string): string {
      const body = text.trimEnd();
      const declaration = \`node \${name}\`;
      return body.length === 0 ? \`\${declaration}\\n\` : \`\${body}\\n\${declaration}\\n\`;
   }
}
`;

   const module = `// GLSP diagram module for __GRAMMAR__ — the DI wiring of one diagram type.
//
// \`declareLanguage\` is the multi-grammar seam: it binds the grammar this diagram
// edits on the SESSION container, so \`modelState.diagramLanguage\` and the
// per-language lookups resolve to __LANGUAGE_ID__. That is what stops one
// diagram type from fighting over a process-wide binding when a project holds
// several grammars — a grammar with no diagram is registered on the same server.
//
// \`configureActionHandlers\` REBINDS rather than adds: GLSP's own
// \`DiagramModule\` already registers \`ComputedBoundsActionHandler\`, and two
// handlers for one action would both run.
//
// \`configureOperationHandlers\` ADDS: GLSP's default pair
// (\`CompoundOperationHandler\` and \`LayoutOperationHandler\`) mutates no source
// model, so the starter create handler is what makes this diagram editable at all.

${importList(
   [
      'ActionHandlerConstructor',
      'BindingTarget',
      'DiagramConfiguration',
      'GModelFactory',
      'GModelIndex',
      'InstanceMultiBinding',
      'ModelState',
      'ModelSubmissionHandler',
      'OperationHandlerConstructor',
      'SourceModelStorage'
   ],
   '@eclipse-glsp/server',
   columns,
   true
)}
import { ComputedBoundsActionHandler } from '@eclipse-glsp/server';
import type { LanguageMetaData } from '@hydranium/langium';
${importList(
   ['HydraniumGlspComputedBoundsActionHandler', 'AbstractHydraniumGlspDiagramModule', 'HydraniumGlspIndex'],
   '@hydranium/glsp-server',
   columns
)}
import { __GRAMMAR__LanguageMetaData } from '../../language-server/generated/module.js';
import { __GRAMMAR__CreateNodeOperationHandler } from './create-node-operation-handler.js';
import { __GRAMMAR__DiagramConfiguration } from './diagram-configuration.js';
import { __GRAMMAR__GModelFactory } from './gmodel-factory.js';
import { __GRAMMAR__GlspState } from './state.js';
import { __GRAMMAR__GlspStorage } from './storage.js';
import { __GRAMMAR__SubmissionHandler } from './submission-handler.js';
import { ${upper}_DIAGRAM_TYPE } from './types.js';

export class __GRAMMAR__DiagramModule extends AbstractHydraniumGlspDiagramModule {
   readonly diagramType = ${upper}_DIAGRAM_TYPE;

   protected override declareLanguage(): LanguageMetaData {
      return __GRAMMAR__LanguageMetaData;
   }

   protected override bindModelState(): BindingTarget<ModelState> {
      return { service: __GRAMMAR__GlspState };
   }

   protected override bindSourceModelStorage(): BindingTarget<SourceModelStorage> {
      return { service: __GRAMMAR__GlspStorage };
   }

   protected override bindModelSubmissionHandler(): BindingTarget<ModelSubmissionHandler> {
      return { service: __GRAMMAR__SubmissionHandler };
   }

   protected override bindDiagramConfiguration(): BindingTarget<DiagramConfiguration> {
      return { service: __GRAMMAR__DiagramConfiguration };
   }

   protected override bindGModelFactory(): BindingTarget<GModelFactory> {
      return { service: __GRAMMAR__GModelFactory };
   }

   /** The framework index unmodified — it keys elements by name, with a positional fallback. */
   protected override bindGModelIndex(): BindingTarget<GModelIndex> {
      return { service: HydraniumGlspIndex };
   }

   protected override configureActionHandlers(binding: InstanceMultiBinding<ActionHandlerConstructor>): void {
      super.configureActionHandlers(binding);
      binding.rebind(ComputedBoundsActionHandler, HydraniumGlspComputedBoundsActionHandler);
   }

   protected override configureOperationHandlers(binding: InstanceMultiBinding<OperationHandlerConstructor>): void {
      super.configureOperationHandlers(binding);
      binding.add(__GRAMMAR__CreateNodeOperationHandler);
   }
}
`;

   return [
      { path: `${dir}/types.ts`, content: render(types) },
      { path: `${dir}/state.ts`, content: render(state) },
      { path: `${dir}/storage.ts`, content: render(storage) },
      { path: `${dir}/submission-handler.ts`, content: render(submission) },
      { path: `${dir}/gmodel-factory.ts`, content: render(factory) },
      { path: `${dir}/diagram-configuration.ts`, content: render(configuration) },
      { path: `${dir}/create-node-operation-handler.ts`, content: render(createHandler) },
      { path: `${dir}/diagram-module.ts`, content: render(module) }
   ];
}

/**
 * Every file the scaffold emits, fully rendered.
 *
 * Grammar-count-dependent emissions live here rather than in a template string:
 * one `.langium` file per grammar, and the shared `common.langium` fragment only
 * when there is more than one grammar to share it.
 */
export function buildInitTemplates(composition: InitComposition): InitFile[] {
   const multi = composition.grammars.length > 1;
   const grammarFiles: InitFile[] = composition.grammars.map(grammar => ({
      path: `src/grammar/${grammar.grammarId}.langium`,
      content: render(grammarFile(multi), composition, grammar)
   }));
   if (multi) {
      grammarFiles.unshift({ path: 'src/grammar/common.langium', content: COMMON_GRAMMAR });
   }

   const diagramFiles = composition.grammars.filter(grammar => grammar.diagram).flatMap(grammar => glspFiles(composition, grammar));

   return [
      { path: 'package.json', content: packageJson(composition) },
      { path: 'langium-config.json', content: langiumConfig(composition) },
      { path: 'tsconfig.json', content: tsconfigJson(composition) },
      { path: 'tsconfig.test.json', content: TSCONFIG_TEST },
      { path: 'vitest.config.ts', content: VITEST_CONFIG },
      {
         path: '.gitignore',
         content: composition.packaging.workspace === undefined ? GITIGNORE : GITIGNORE_WORKSPACE_MEMBER
      },
      { path: 'README.md', content: readme(composition) },
      ...grammarFiles,
      { path: `src/language-server/${composition.projectId}-module.ts`, content: moduleFile(composition) },
      { path: 'src/language-server/ast.ts', content: render(AST, composition, composition.grammars[0]) },
      ...composition.grammars.map(grammar => ({
         path: `src/language-server/${grammar.grammarId}-serializer.ts`,
         content: render(SERIALIZER, composition, grammar)
      })),
      { path: 'src/index.ts', content: indexFile(composition) },
      { path: 'src/services.ts', content: project(SERVICES, composition) },
      { path: 'src/main.ts', content: mainFile(composition) },
      ...(composition.heads.includes('data') ? [{ path: 'src/data-server-main.ts', content: dataServerMainFile(composition) }] : []),
      ...(portCommandNames(composition).length ? [{ path: 'src/head-ports.ts', content: headPortsFile(composition) }] : []),
      ...diagramFiles,
      { path: 'test/services.test.ts', content: servicesTest(composition) },
      { path: 'test/parsing.test.ts', content: grammarTest(composition, PARSING_HEADER, [], PARSING_SUITE) },
      {
         path: 'test/linking.test.ts',
         content: grammarTest(composition, LINKING_HEADER, ["import { AstUtils } from '@hydranium/langium';"], LINKING_SUITE)
      },
      {
         path: 'test/validating.test.ts',
         content: grammarTest(
            composition,
            VALIDATING_HEADER,
            ["import { DiagnosticSeverity } from 'vscode-languageserver';"],
            VALIDATING_SUITE
         )
      },
      { path: 'test/serialization.test.ts', content: serializationTest(composition) }
   ];
}
