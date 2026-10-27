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
 * - `__PROTOCOL_PACKAGE__` — the protocol member's package name, scope
 *   included, which the server and every client import ids and wire types
 *   from.
 * - `__SERVER_PACKAGE__` / `__CLIENT_PACKAGE__` — the server and client
 *   members' package names, which a host imports the language and the diagram
 *   definition from.
 *
 * GRAMMAR tokens, substituted once per grammar:
 *
 * - `__GRAMMAR__` — PascalCase grammar name, the `grammar X` declaration.
 *   Drives the PER-LANGUAGE generated symbols (`<grammar>GeneratedModule`,
 *   `<grammar>LanguageMetaData`).
 * - `__GRAMMAR_ID__` — kebab grammar id: the `.langium` filename.
 * - `__GRAMMAR_ID_CONST__` — SCREAMING_SNAKE grammar id, prefixing the
 *   diagram's type-id constants.
 * - `__GRAMMAR_CAMEL__` — lowerCamelCase grammar name, naming the client's
 *   diagram module constant.
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
 * The project is its packages and a starter workspace, each in its own
 * directory: `server/` (the grammar, the language and its heads), `protocol/`
 * (what the server and its clients both import, so a client never installs
 * Langium), `client/` with a diagram (its host-neutral client side),
 * `host-<name>/` per host, `vscode-servers/` with the VS Code host (the server
 * launch it shares with a Theia app), and `workspace/` (starter model files
 * every host and the CLI open). A standalone project adds a root manifest
 * naming them as npm workspaces; a workspace member joins the surrounding root
 * instead.
 *
 * A file that is fixed text with tokens lives in the `templates/` tree the
 * package ships beside `lib`, at the path it is emitted at, tokens included
 * (each ignore file without its dot); one computed from the composition is
 * built here. The tree is read synchronously, so `runInit` stays synchronous,
 * and it is neither formatted with the repo's settings nor given a license
 * header, since either would change what `init` emits.
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

import { readFileSync } from 'node:fs';
import { readCliVersion } from '../cli-version.js';
import { type InitComposition, type InitFile, type InitGrammarNames, type InitHead, type InitMember, initMembers } from './init.js';
import { isTheiaHost } from './init-hosts.js';
import type { JsonValue } from './init-workspace.js';

/** One template file: its path (tokens allowed) and its content (tokens allowed). */
export interface InitTemplate {
   path: string;
   content: string;
}

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

const VSCODE_EXTENSION_MEMBERS: readonly InitMember[] = ['vscode-servers', 'host-vscode'];

/**
 * A member's package name: `<id>-<member>`, under the scope when there is one,
 * except for the VS Code extensions, whose scoped name `vsce` refuses to
 * package.
 *
 * Suffixed even for the server, because a project of several packages has no
 * member entitled to the bare id, and a later client or host would otherwise
 * read as a part of the server.
 */
export function memberPackageName(composition: InitComposition, member: InitMember): string {
   const { scope } = composition.packaging;
   const name = `${composition.projectId}-${member}`;
   return scope === undefined || VSCODE_EXTENSION_MEMBERS.includes(member) ? name : `${scope}/${name}`;
}

/**
 * The composition as one member sees it: inside a workspace, its placement
 * sits one directory below the project's, so its `extends` and its lint
 * config path reach one level further up.
 */
function forMember(composition: InitComposition, member: InitMember): InitComposition {
   const workspace = composition.packaging.workspace;
   if (workspace === undefined) {
      return composition;
   }
   return {
      ...composition,
      packaging: {
         ...composition.packaging,
         workspace: {
            ...workspace,
            targetPath: `${workspace.targetPath}/${member}`,
            baseTsconfig: workspace.baseTsconfig === undefined ? undefined : `../${workspace.baseTsconfig}`
         }
      }
   };
}

/** Substitute the project-tier tokens. */
function project(text: string, composition: InitComposition): string {
   return text
      .replace(/__NAME__/g, composition.name)
      .replace(/__PROJECT_ID__/g, composition.projectId)
      .replace(/__CONFIG_ROOT_CONST__/g, screamingSnake(composition.projectId))
      .replace(/__PROTOCOL_PACKAGE__/g, memberPackageName(composition, 'protocol'))
      .replace(/__SERVER_PACKAGE__/g, memberPackageName(composition, 'server'))
      .replace(/__CLIENT_PACKAGE__/g, memberPackageName(composition, 'client'));
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
      .replace(/__GRAMMAR_ID_CONST__/g, screamingSnake(grammar.grammarId))
      .replace(/__GRAMMAR_ID__/g, grammar.grammarId)
      .replace(/__GRAMMAR_CAMEL__/g, grammar.grammar.charAt(0).toLowerCase() + grammar.grammar.slice(1))
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

/** The template tree, the same two levels up from `src/commands` and `lib/commands`. */
const TEMPLATES = new URL('../../templates/', import.meta.url);

/** One template file's text. */
function template(path: string): string {
   return readFileSync(new URL(path, TEMPLATES), 'utf-8');
}

/** A template emitted once per project at its own path, rendered with the project tokens. */
function projectTemplate(path: string, composition: InitComposition): InitFile {
   return { path, content: project(template(path), composition) };
}

/** A template emitted once per grammar, its path rendered like its content. */
function grammarTemplate(path: string, composition: InitComposition, grammar: InitGrammarNames): InitFile {
   return { path: render(path, composition, grammar), content: render(template(path), composition, grammar) };
}

/** An ignore file, stored without its dot because `npm pack` drops a nested `.gitignore` and applies it as an ignore file. */
function ignoreFile(directory: string): InitFile {
   const prefix = directory === '' ? '' : `${directory}/`;
   return { path: `${prefix}.gitignore`, content: template(`${prefix}gitignore`) };
}

/** A comma-separated list of single-quoted TypeScript/JS string literals. */
function quotedList(values: readonly string[]): string {
   return values.map(value => `'${value}'`).join(', ');
}

/**
 * The column budget the emitted sources wrap at when nothing better is known.
 *
 * **Not "prettier's default"** — that is 80. No single width is stable for an
 * unknown repo, so emitted code only passes a formatter check relative to a
 * config. A workspace scaffold detects the surrounding repo's `printWidth` and
 * uses it (see {@link columnsFor}); a standalone one has no config to read and
 * falls back here. It is the framework's own width, so a fixed template, which
 * wraps at no budget, reads the same in a standalone scaffold as in the
 * examples this repo formats.
 */
const DEFAULT_COLUMNS = 140;

/** The width THIS composition wraps at: the detected workspace one, else {@link DEFAULT_COLUMNS}. */
function columnsFor(composition: InitComposition): number {
   return composition.packaging.workspace?.printWidth ?? DEFAULT_COLUMNS;
}

/**
 * A named import on one line while it fits the column budget, else one symbol
 * per line. Emitted files are supposed to pass a format check as-is, and the
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
 *
 * `base` is every head set's: the services every head serves from are composed
 * the same with or without an LSP head.
 */
const HEAD_FRAMEWORK_DEPENDENCIES: Record<InitHead | 'base', readonly string[]> = {
   base: ['@hydranium/core', '@hydranium/langium', '@hydranium/protocol'],
   lsp: [],
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
 * `langium` is required even though hand-written code goes through the
 * `@hydranium/langium` chokepoint, because `langium-cli` emits direct imports
 * into the generated files and regenerates them on every build. The `vscode-*`
 * packages are required peers of `@hydranium/core`, so they are `base` too.
 */
const HEAD_THIRD_PARTY_DEPENDENCIES: Record<InitHead | 'base', Readonly<Record<string, string>>> = {
   base: {
      langium: '4.4.0',
      // Exact, as are the protocol and transport it pins, so Langium and the
      // framework share their copies; across copies, an error a handler throws
      // or returns loses its code, and a later patch can pin another protocol.
      'vscode-languageserver': '10.1.2',
      'vscode-jsonrpc': '9.0.3',
      'vscode-languageserver-protocol': '3.18.4',
      // The copy that protocol pins; a root without it takes the one Theia pins.
      'vscode-languageserver-types': '3.18.4'
   },
   lsp: {},
   data: {},
   glsp: {
      '@eclipse-glsp/graph': '2.8.0',
      '@eclipse-glsp/server': '2.8.0',
      // `^6.1.3` and NOT `^6.0.0`: `@eclipse-glsp/server` requires it, and
      // `^6.0.0` resolved only because the hoisted copy happened to satisfy it.
      inversify: '^6.1.3',
      'reflect-metadata': '~0.2.2'
   }
};

/**
 * What each head adds to the protocol member, which carries only what a
 * client may install. Keyed by head because the `glsp` head implies a diagram,
 * whose element ids extend GLSP's default type names.
 */
const PROTOCOL_THIRD_PARTY_DEPENDENCIES: Record<InitHead, Readonly<Record<string, string>>> = {
   lsp: {},
   data: {},
   glsp: { '@eclipse-glsp/protocol': '2.8.0' }
};

/** The client member's packages: the diagram definition and what it registers its elements with. */
const CLIENT_FRAMEWORK_DEPENDENCIES: readonly string[] = ['@hydranium/glsp-client'];
const CLIENT_THIRD_PARTY_DEPENDENCIES: Readonly<Record<string, string>> = {
   '@eclipse-glsp/client': '2.8.0',
   inversify: '^6.1.3'
};

/**
 * What each head adds to the browser host, which bundles the server into its
 * worker and the head's client into its page. `base` is what every page needs.
 *
 * `monaco-editor-core` is exact for the reason `langium` is: Monaco's models
 * live in one copy, and `@hydranium/client-browser` must reach the page's.
 */
const HOST_BROWSER_FRAMEWORK_DEPENDENCIES: Record<InitHead | 'base', readonly string[]> = {
   base: ['@hydranium/client-browser', '@hydranium/core', '@hydranium/protocol'],
   lsp: [],
   data: ['@hydranium/data-server'],
   glsp: ['@hydranium/glsp-client', '@hydranium/glsp-server']
};
const HOST_BROWSER_THIRD_PARTY_DEPENDENCIES: Record<InitHead | 'base', Readonly<Record<string, string>>> = {
   base: { 'vscode-jsonrpc': '9.0.3', 'vscode-languageserver-protocol': '3.18.4' },
   lsp: { 'monaco-editor-core': '0.56.0' },
   data: {},
   glsp: { '@eclipse-glsp/server': '2.8.0', 'reflect-metadata': '~0.2.2' }
};

/** The browser host's tools: the bundler, the smoke tier and the type check. */
const HOST_BROWSER_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
   '@playwright/test': '^1.55.0',
   '@types/node': '^22.0.0',
   esbuild: '^0.28.0',
   rimraf: '^5.0.0',
   typescript: '^7.0.2'
};

/** The language client both VS Code extensions start the server with. */
const VSCODE_LANGUAGE_CLIENT: Readonly<Record<string, string>> = { 'vscode-languageclient': '^9.0.1' };

/** The VS Code API's types, at the oldest VS Code both extensions run in, which `engines` names too. */
const VSCODE_ENGINE = '^1.101.0';

/**
 * What the GLSP head adds to the VS Code extension: the connector in the
 * extension host and the diagram webview's starter, which bundles the client
 * member.
 */
const HOST_VSCODE_GLSP_FRAMEWORK_DEPENDENCIES: readonly string[] = [
   '@hydranium/client-vscode',
   '@hydranium/glsp-client',
   '@hydranium/glsp-client-vscode',
   '@hydranium/protocol'
];
const HOST_VSCODE_GLSP_THIRD_PARTY_DEPENDENCIES: Readonly<Record<string, string>> = {
   '@eclipse-glsp/client': '2.8.0',
   '@eclipse-glsp/vscode-integration': '2.8.0',
   '@eclipse-glsp/vscode-integration-webview': '2.8.0',
   inversify: '^6.1.3',
   'vscode-jsonrpc': '9.0.3'
};

/** What the data head adds to the VS Code extension: the Show Model command's socket to it. */
const HOST_VSCODE_DATA_FRAMEWORK_DEPENDENCIES: readonly string[] = [
   '@hydranium/client-vscode',
   '@hydranium/data-client-vscode',
   '@hydranium/protocol'
];
// Exact, as the server's is: the socket's connection and the framework's must be one copy.
const HOST_VSCODE_DATA_THIRD_PARTY_DEPENDENCIES: Readonly<Record<string, string>> = { 'vscode-jsonrpc': '9.0.3' };

/** The VS Code extension's tools: the smoke tier, the download it runs in, the type check and the watch. */
const HOST_VSCODE_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
   '@playwright/test': '^1.55.0',
   '@types/node': '^22.0.0',
   '@types/vscode': VSCODE_ENGINE,
   '@vscode/test-electron': '^3.1.0',
   concurrently: '^9.0.0',
   rimraf: '^5.0.0',
   typescript: '^7.0.2'
};

/**
 * The exact pins of every member the composition emits, for a workspace root
 * to declare too. npm installs a root's own dependencies at the top of the
 * tree, so another member's version of one nests beneath that member instead of
 * taking the place of the copy this package shares with the framework.
 */
export function workspaceRootPins(composition: InitComposition): ReadonlyArray<readonly [string, string]> {
   const { heads } = composition;
   const members = initMembers(heads, composition.hosts);
   const pins = new Map([
      ...Object.entries(HEAD_THIRD_PARTY_DEPENDENCIES.base),
      ...heads.flatMap(head => [
         ...Object.entries(HEAD_THIRD_PARTY_DEPENDENCIES[head]),
         ...Object.entries(PROTOCOL_THIRD_PARTY_DEPENDENCIES[head])
      ]),
      ...(members.includes('client') ? Object.entries(CLIENT_THIRD_PARTY_DEPENDENCIES) : []),
      ...(members.includes('host-browser')
         ? (['base', ...heads] as const).flatMap(head => Object.entries(HOST_BROWSER_THIRD_PARTY_DEPENDENCIES[head]))
         : []),
      ...(members.includes('host-vscode') && heads.includes('glsp') ? Object.entries(HOST_VSCODE_GLSP_THIRD_PARTY_DEPENDENCIES) : []),
      ...(members.includes('host-vscode') && heads.includes('data') ? Object.entries(HOST_VSCODE_DATA_THIRD_PARTY_DEPENDENCIES) : []),
      ...(members.includes('theia') ? theiaThirdPartyDependencies(heads) : []),
      ...(members.includes('host-theia-browser') ? hostTheiaBrowserTheiaDependencies() : []),
      ...(members.includes('host-theia-electron') ? hostTheiaElectronPins() : [])
   ]);
   return [...pins].filter(([, version]) => /^\d+\.\d+\.\d+$/.test(version)).sort(([left], [right]) => left.localeCompare(right));
}

/** Whether an npm version is 11.6.0 or later, the first that installs `vitest` 4.1's peer set; `11.6.0-rc.1` is earlier. */
function installsVitest41(npmVersion: string | undefined): boolean {
   const [release, prerelease] = (npmVersion ?? '0.0.0').split('-', 2);
   const [major, minor, patch] = release.split('.').map(Number);
   return major > 11 || (major === 11 && (minor > 6 || (minor === 6 && (patch > 0 || prerelease === undefined))));
}

/**
 * Whether the scaffold holds `vitest` below 4.1, whose peer set crashes npm
 * before 11.6 (every npm a Node 22 release bundles) on the first install. Only a
 * workspace root declaring a newer npm lifts it, and only when `init` runs under
 * an npm known to be newer: npm does not enforce `packageManager`.
 */
function pinsVitest(composition: InitComposition): boolean {
   const workspace = composition.packaging.workspace;
   return !(installsVitest41(workspace?.packageManagerNpm) && installsVitest41(workspace?.npmVersion));
}

/**
 * The version a member pins a sibling member at: exact, at the version every
 * member starts with. npm links a sibling only when the range admits its local
 * version, and otherwise looks for it in the registry, where it was never
 * published.
 */
const MEMBER_PIN = '0.0.0';

/** A dependency block, sorted as npm writes it. */
function sortedBlock(dependencies: Readonly<Record<string, string>>, indent: string): string {
   return Object.keys(dependencies)
      .sort()
      .map(name => `${indent}"${name}": "${dependencies[name]}"`)
      .join(',\n');
}

/** The server's dependency block: the base and head set's packages and the protocol member. */
function dependencyBlock(composition: InitComposition, indent: string): string {
   const merged: Record<string, string> = { [memberPackageName(composition, 'protocol')]: MEMBER_PIN };
   for (const head of ['base', ...composition.heads] as const) {
      Object.assign(merged, HEAD_THIRD_PARTY_DEPENDENCIES[head]);
      for (const framework of HEAD_FRAMEWORK_DEPENDENCIES[head]) {
         merged[framework] = frameworkPin(composition);
      }
   }
   return sortedBlock(merged, indent);
}

// JSON at two-space indent, not the three the `.ts` templates use: that is the
// npm convention, and `npm install` rewrites `package.json` at two spaces
// regardless — so three would not survive the adopter's first install.
//
// The KEY ORDER is the one Oxfmt's `sortPackageJson` canonicalises to, `private`
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
// `exports` puts `createServices`, the one module reading the real filesystem,
// behind `./node`, so the root loads in a browser worker that has no `node:fs`.
// `./lib/*` and `./package.json` stay reachable for a host that resolves
// `<server>/lib/main.js` to spawn the server.
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
__KEYWORDS__  ],
  "license": "UNLICENSED",
  "author": "",
  "bin": {
__BIN__  },
  "files": [
    "lib",
    "src",
    "syntaxes"
  ],
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "default": "./lib/index.js"
    },
    "./node": {
      "types": "./lib/node/services.d.ts",
      "default": "./lib/node/services.js"
    },
    "./lib/*": "./lib/*",
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "npm run generate && tsc -b",
    "clean": "rimraf lib syntaxes src/language-server/generated src/language-server/generated-hydranium test/generated-hydranium tsconfig.tsbuildinfo",
    "generate": "npm run langium:generate && npm run generate:transfer-model",
    "generate:transfer-model": "hydranium-cli generate-transfer-model --ast-file src/language-server/generated/ast.ts --augmentation-file src/language-server/ast.ts --out-file ../protocol/src/generated-hydranium/transfer-model.ts --ast-builder-file src/language-server/generated-hydranium/ast-builder.ts --transfer-builder-file test/generated-hydranium/transfer-builder.ts --languages-file ../protocol/src/generated-hydranium/languages.ts --element-type-name __NAME__Element --terminals-name __NAME__Terminals --regen-command \\"Run: __NPM_RUN__ generate:transfer-model\\"",
    "langium:generate": "langium generate",
    "langium:watch": "langium generate --watch",
__LINT__    "start": "node lib/main.js__START_ARGS__",
    "test": "npm run typecheck:test && vitest run",
    "typecheck:test": "tsc --noEmit -p tsconfig.test.json",
    "watch": "concurrently --kill-others --names langium,transfer-model,tsc \\"npm run langium:watch\\" \\"npm run generate:transfer-model -- --watch\\" \\"tsc -b --watch\\""
  },
  "dependencies": {
__DEPENDENCIES__
  },
  "devDependencies": {
    "@hydranium/cli": "__FRAMEWORK_PIN__",
    "@types/node": "^22.0.0",
    "concurrently": "^9.0.0",
    "langium-cli": "4.4.0",
    "rimraf": "^5.0.0",
    "typescript": "^7.0.2",
    "vitest": "__VITEST__"
  },
  "engines": {
    "node": ">=22.13"
  }
}
`;

/**
 * How the scaffold names `npm run` for one member's script.
 *
 * Always with `--prefix`, from the directory commands are run in: the
 * workspace root for a member, the project root for a standalone project. A
 * bare `npm run` there reaches the ROOT manifest and fails, and the regen hint
 * a generated file prints is read in `protocol/` as well, where the script it
 * names does not exist.
 */
function npmRun(composition: InitComposition, member: InitMember): string {
   const workspace = composition.packaging.workspace;
   return `npm --prefix ${workspace === undefined ? member : `${workspace.targetPath}/${member}`} run`;
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
 * Alphabetical, because Oxfmt's `sortPackageJson` sorts `bin` and any other
 * order is rewritten by the scaffolded project's first `format` run.
 */
function binBlock(composition: InitComposition): string {
   const entries: Array<[string, string]> = [[composition.projectId, 'lib/main.js']];
   if (composition.heads.includes('data')) {
      entries.push([`${composition.projectId}-data-server`, 'lib/data-server-main.js']);
   }
   return entries.map(([name, target]) => `    "${name}": "${target}"`).join(',\n') + '\n';
}

/**
 * A member's `lint` script line, over `directories`, or nothing.
 *
 * Emitted only where a root lint config says the repo lints. The absence is
 * the dangerous direction: a task runner runs a script only where one is
 * declared, so a package with no `lint` is SKIPPED rather than reported, and
 * that reads as a clean lint. A wrong invocation is one visible line to edit.
 */
function lintScript(member: InitComposition, directories: string): string {
   const workspace = member.packaging.workspace;
   if (workspace?.oxlintConfig !== undefined) {
      const config = `${'../'.repeat(workspace.targetPath.split('/').length)}${workspace.oxlintConfig}`;
      return `    "lint": "oxlint --report-unused-disable-directives --format stylish --config ${config} ${directories} --max-warnings 0",\n`;
   }
   return workspace?.eslintConfig !== undefined ? `    "lint": "eslint ${directories} --max-warnings 0",\n` : '';
}

/** The server's `package.json`, with the name, the private flag and the dependency block all derived. */
function packageJson(composition: InitComposition): string {
   const keywords =
      ['hydranium', 'langium', 'language-server', composition.projectId]
         .sort()
         .map(keyword => `    ${JSON.stringify(keyword)}`)
         .join(',\n') + '\n';
   return project(PACKAGE_JSON, composition)
      .replace('__PACKAGE_NAME__', memberPackageName(composition, 'server'))
      .replace('__KEYWORDS__', keywords)
      .replace('__BIN__', binBlock(composition))
      .replace('__LINT__', lintScript(forMember(composition, 'server'), 'src test'))
      .replace('__START_ARGS__', composition.heads.includes('lsp') ? ' --stdio' : ' ../workspace')
      .replace('__VITEST__', pinsVitest(composition) ? '~4.0.18' : '^4.0.0')
      .replace('__PRIVATE__', composition.packaging.private ? '  "private": true,\n' : '')
      .replace('__NPM_RUN__', npmRun(composition, 'server'))
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
   // A server that renders its own user-facing messages loads a catalogue, and
   // a catalogue is JSON. Without this the import does not resolve at all, and
   // without the `include` glob below a composite project rejects it with
   // TS6307 naming neither cause.
   ['resolveJsonModule', true],
   ['skipLibCheck', true],
   ['declaration', true],
   ['experimentalDecorators', true],
   ['emitDecoratorMetadata', true],
   ['forceConsistentCasingInFileNames', true],
   ['types', ['node']]
];

/** The protocol member's compiler options, pruned against a workspace base like the server's. */
const PROTOCOL_COMPILER_OPTIONS: ReadonlyArray<readonly [string, JsonValue]> = [
   ['target', 'ES2022'],
   ['lib', ['ES2022']],
   ['module', 'NodeNext'],
   ['moduleResolution', 'NodeNext'],
   ['rootDir', 'src'],
   ['outDir', 'lib'],
   ['strict', true],
   ['skipLibCheck', true],
   ['declaration', true],
   // The server's `tsc -b` builds this project through a reference, which
   // `tsc` refuses unless the referenced project is composite.
   ['composite', true],
   // No ambient Node types: a browser client compiles against this package.
   ['types', []]
];

/**
 * The options that describe where THIS package's own files live. Never pruned,
 * and emitted first in the workspace case: a base config that supplied them
 * would be pointing every member at one directory, so a match there means the
 * base is wrong rather than that the member is redundant.
 */
const PACKAGE_LOCAL_OPTIONS: readonly string[] = ['rootDir', 'outDir'];

/**
 * The enum-valued options of {@link TSCONFIG_COMPILER_OPTIONS}, whose values
 * `tsc` reads case-insensitively, so `nodenext` and `NodeNext` are one value.
 * An enum-valued option added there belongs here too.
 */
const CASE_INSENSITIVE_OPTIONS: readonly string[] = ['target', 'lib', 'module', 'moduleResolution'];

/** Compare two option values. Sound here because compiler options are scalars and flat arrays. */
function optionEquals(key: string, left: JsonValue | undefined, right: JsonValue): boolean {
   const normalise = (value: JsonValue | undefined) => {
      const text = JSON.stringify(value);
      return CASE_INSENSITIVE_OPTIONS.includes(key) ? text?.toLowerCase() : text;
   };
   return normalise(left) === normalise(right);
}

/**
 * `tsconfig.json`, extending the workspace's base config when there is one.
 *
 * Options are dropped only when the base supplies the SAME value, never merely
 * the same key: inheriting `"module": "CommonJS"` where the scaffold needs
 * `NodeNext` would break every emitted import, so a differing base value is a
 * reason to keep the override rather than to trust the parent.
 *
 * `member` is the composition as that member sees it, so `extends` reaches the
 * workspace base from the member's own directory.
 */
function tsconfigJson(
   member: InitComposition,
   compilerOptions: ReadonlyArray<readonly [string, JsonValue]>,
   include: string,
   references = ''
): string {
   const workspace = member.packaging.workspace;
   const base = workspace?.baseTsconfig === undefined ? undefined : (workspace.baseCompilerOptions ?? {});
   const options =
      base === undefined
         ? compilerOptions
         : [
              ...compilerOptions.filter(([key]) => PACKAGE_LOCAL_OPTIONS.includes(key)),
              ...compilerOptions.filter(([key, value]) => !PACKAGE_LOCAL_OPTIONS.includes(key) && !optionEquals(key, base[key], value))
           ];
   const extendsLine = workspace?.baseTsconfig === undefined ? '' : `  "extends": "${workspace.baseTsconfig}",\n`;
   // An array spaced as a formatter writes it, which `JSON.stringify` does not.
   const json = (value: JsonValue): string => (Array.isArray(value) ? `[${value.map(json).join(', ')}]` : JSON.stringify(value));
   const body = options.map(([key, value]) => `    "${key}": ${json(value)}`).join(',\n');
   const referencesLine = references === '' ? '' : `,\n  "references": ${references}`;
   return `{\n${extendsLine}  "compilerOptions": {\n${body}\n  },\n  "include": ${include}${referencesLine}\n}\n`;
}

/**
 * The server's `tsconfig.json`. It references the protocol member, so `tsc -b`
 * compiles protocol first, after `generate` has written its generated modules.
 */
function serverTsconfigJson(composition: InitComposition): string {
   return tsconfigJson(
      forMember(composition, 'server'),
      TSCONFIG_COMPILER_OPTIONS,
      '["src", "src/**/*.json"]',
      '[{ "path": "../protocol" }]'
   );
}

/**
 * The terminals every grammar needs: the shared fragment's text after its
 * leading comment run, so a lone grammar declares the same set.
 */
function terminals(): string {
   return template('server/src/grammar/common.langium').replace(/^(\/\/.*\n)*\n/, '');
}

/** One starter grammar. `shared` decides whether it imports the fragment or declares its own terminals. */
function grammarFile(shared: boolean): string {
   const lexis = shared ? "import './common'\n" : `\n${terminals()}`;
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
      .flatMap(grammar => [
         `import { ${grammar.grammar}Serializer } from './${grammar.grammarId}-serializer.js';`,
         `import { ${grammar.grammar}ValidationContribution } from './${grammar.grammarId}-validation.js';`
      ])
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
   },
   validation: {
      checks: {
         names: () => new ${grammar.grammar}ValidationContribution()
      }
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
// \`createIntegrationServices\`). Each adopter module binds its language's
// \`Serializer\`, which the framework cannot default because a concrete syntax
// is grammar knowledge, and its validation checks. Everything else (scope,
// naming, project management, build pipeline) boots on the framework defaults;
// scope computation and AST extensions go in these same modules.
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
// \`createIntegrationServices\`, generated from this same \`langium-config.json\`.
// With several languages, bind \`lsp.configurationRoot\` in
// \`__NAME__SharedModule\`, or the framework warns and takes the first
// language's id. Type that module's second \`Module\` argument as
// \`PartialLangiumSharedServices & { lsp: { configurationRoot: string } }\`.`
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

/** One exported constant of the protocol member's `head-ports.ts`. */
interface HeadPortConstant {
   readonly name: string;
   readonly value: string;
   readonly doc: string;
}

/**
 * How a host finds each socket head's port, in emission order: an LSP request
 * when the LSP head publishes the ports, else the environment variable
 * `main.ts` reads a port from.
 *
 * Keyed by the PROJECT rather than by a language: one server of each kind per
 * process serves every registered grammar, so a language-derived name would tie
 * a project-level endpoint to whichever grammar was scaffolded first.
 */
function headPortConstants(composition: InitComposition): HeadPortConstant[] {
   const upper = screamingSnake(composition.projectId);
   const lsp = composition.heads.includes('lsp');
   return socketHeads(composition).map(head =>
      lsp
         ? {
              name: `${upper}_${head.key}_PORT_COMMAND`,
              value: `${composition.projectId}/${head.path}/port`,
              doc: `LSP request the host queries to discover the ${head.label} socket port.`
           }
         : {
              name: `${upper}_${head.key}_PORT_ENV`,
              value: `${upper}_${head.key}_PORT`,
              doc: `Environment variable naming the ${head.label} socket port when no \`--${head.path}-port\` flag does.`
           }
   );
}

/** The socket heads of the composition, as `head-ports.ts` names them. */
function socketHeads(composition: InitComposition) {
   return [
      ...(composition.heads.includes('data')
         ? [{ key: 'DATA_SERVER', path: 'data-server', command: 'dataServer', label: 'data-server' }]
         : []),
      ...(composition.heads.includes('glsp') ? [{ key: 'GLSP_SERVER', path: 'glsp-server', command: 'glsp', label: 'GLSP' }] : [])
   ];
}

/** Whether the composition emits the servers-only extension, which VS Code starts the server through and a Theia app sideloads. */
function emitsVscodeServers(composition: InitComposition): boolean {
   return initMembers(composition.heads, composition.hosts).includes('vscode-servers');
}

/**
 * The host commands the servers extension answers each socket head's port
 * under, for a host without a language client of its own.
 */
function hostCommandConstants(composition: InitComposition): HeadPortConstant[] {
   if (!emitsVscodeServers(composition)) {
      return [];
   }
   const upper = screamingSnake(composition.projectId);
   return socketHeads(composition).map(head => ({
      name: `${upper}_${head.key}_HOST_COMMAND`,
      value: `${composition.projectId}.port.${head.command}`,
      doc: `Host command the servers extension answers with the ${head.label} socket port.`
   }));
}

/**
 * The socket heads' port commands or variables, in the protocol member.
 *
 * A host shell has to name the same string the server reads, and reaches it
 * here without depending on the server. A host that retypes the literal
 * instead gets no error when it drifts: the framework's port poll defaults to
 * `findPortAttempts = -1`, so a wrong command retries forever rather than
 * failing, and a wrong variable is never read.
 */
function headPortsFile(composition: InitComposition): string {
   const constants = [...headPortConstants(composition), ...hostCommandConstants(composition)];
   const blocks = constants.map(constant => `/** ${constant.doc} */\nexport const ${constant.name} = '${constant.value}';`);
   const socketHeadCount = socketHeads(composition).length;
   const heads = `socket head${socketHeadCount > 1 ? 's' : ''}`;
   const opening = composition.heads.includes('lsp')
      ? `// The LSP requests a host queries to discover this server's ${heads}.`
      : `// The environment variables that name the ports of this server's ${heads}.`;
   const usage = composition.heads.includes('lsp')
      ? `// The server publishes them and a host shell has to name the same string to
// reach the head; both import them from here. A shell that retypes the literal
// gets no error when it drifts: the framework's port poll retries indefinitely
// by default.`
      : `// The server reads them and a process that starts it sets them; both import
// them from here. A variable retyped with a typo is never read, and the head
// then listens on whichever port is free.`;
   const hostCommands = emitsVscodeServers(composition)
      ? `
//
// The host commands are the same ports for a host with no language client,
// such as a Theia app sideloading the servers extension: it runs the command
// and the extension sends the request.`
      : '';
   return `${opening}
//
// ${socketHeadCount > 1 ? 'Both are' : 'It is'} keyed by the PROJECT, not the language: one server of each kind per
// process serves every registered grammar, so a language-derived name would tie
// a project-level endpoint to whichever grammar was scaffolded first.
//
${usage}${hostCommands}

${blocks.join('\n\n')}
`;
}

/**
 * The server's root entry: the DI factory, the generated AST and each diagram
 * module, all loadable in a browser worker.
 */
function indexFile(composition: InitComposition): string {
   const diagrams = composition.grammars.filter(grammar => grammar.diagram);
   const diagramPhrase = diagrams.length === 0 ? '' : diagrams.length === 1 ? ', plus the diagram module' : ', plus the diagram modules';
   const text = `// Public surface of the __NAME__ language server: the DI factory and the
// generated AST${diagramPhrase}.
//
// Everything here loads in a browser worker as well as in Node, so a host can
// compose the language wherever it runs it. \`createServices\`, which reads the
// real filesystem, is the package's \`./node\` entry instead. The entry points
// under \`src/\` are not re-exported either: each opens a transport at module
// scope, so importing one starts a server, which is why they are \`bin\` targets.

export * from './language-server/__PROJECT_ID__-module.js';
export * from './language-server/ast.js';
${diagrams.map(grammar => `export * from './glsp/${grammar.grammarId}/diagram-module.js';\n`).join('')}`;
   return project(text, composition);
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
   const roots = composition.grammars.map(grammar => grammar.entryRule).sort();
   const upper = screamingSnake(composition.projectId);
   const lsp = composition.heads.includes('lsp');
   const data = composition.heads.includes('data');
   const glsp = composition.heads.includes('glsp');
   const diagrams = composition.grammars.filter(grammar => grammar.diagram);
   const plural = roots.length > 1 ? 's' : '';
   const portFlags = [...(data ? ['--data-server-port'] : []), ...(glsp ? ['--glsp-server-port'] : [])];

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
   const coreNodeSymbols = ['NodeFileSystem', ...(data ? [...(lsp ? ['publishPortOnLspConnection'] : []), 'startSocketServer'] : [])];
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
${importList(roots, memberPackageName(composition, 'protocol'), columns, true)}
`
      : '';

   // The names live in the protocol member, not here: a host shell has to name
   // the same string to reach the head, and this file is an executable entry,
   // so nothing can import from it.
   const portNames = headPortConstants(composition).map(constant => constant.name);
   const portImports = portNames.length ? importList(portNames, memberPackageName(composition, 'protocol'), columns) + '\n' : '';

   const dataBlock = !data
      ? ''
      : !lsp
        ? `
// Data-server head: each accepted client gets its own DataServer.
const dataServer = startSocketServer(
   { shared, workspace, port: portFrom('data-server-port', ${upper}_DATA_SERVER_PORT_ENV), logTag: 'ModelServer', logger: shared.Logger },
   dataConnection => {
      new DataServer<${roots.join(' | ')}>(dataConnection, shared);
      return { dispose: () => undefined };
   }
);
`
        : `
// Data-server head alongside LSP: binds an ephemeral port, published over the LSP
// connection for the host to discover. Each accepted client gets its own DataServer.
//
// Neither the bind nor the publish may be swallowed: either failure leaves the LSP
// head serving text edits while every data client waits on a port command that was
// never registered, and the launcher reports a bind failure only if given a logger.
const dataServer = startSocketServer({ shared, port: 0, logTag: 'ModelServer', logger: shared.Logger }, dataConnection => {
   new DataServer<${roots.join(' | ')}>(dataConnection, shared);
   return { dispose: () => undefined };
});
dataServer.started
   .then(
      () => {
         const { port } = dataServer;
         if (port === undefined) {
            // \`started\` resolves only once the address is resolved, so this is
            // unreachable; a non-null assertion in its place would publish
            // \`undefined\`, which the host cannot tell from an unreachable port.
            throw new Error('the data head started without a resolved port');
         }
         publishPortOnLspConnection(shared.lsp.Connection, ${upper}_DATA_SERVER_PORT_COMMAND, port);
      },
      // The launcher logged its own bind failure; the rejection is control flow.
      () => undefined
   )
   .catch((error: unknown) => {
      shared.Logger.error(\`[ModelServer] Could not publish the data-server port: \${describeErrorWithStack(error)}\`);
   });
`;

   const glspBlock = glsp
      ? `
// GLSP head on the same shared workspace. \`HydraniumGlspAppModule\` is used
// unsubclassed: the app container is one per process and cannot know which
// grammar a request concerns, so nothing per-language belongs there — each
// diagram module declares its own language instead.
//
${
   lsp
      ? `// GLSP framework logs route through the LSP connection rather than stdout, which
// IS the LSP transport in stdio mode; writing there corrupts the protocol stream.`
      : `// GLSP framework logs route through the framework's logger to stderr. GLSP's
// own startup line goes to stdout, beside the ports line below.`
}
const glspServer = startGlspServer({
   // The GLSP log threshold lives on the logger, not beside it: the framework
   // replaces GLSP's own \`Logger\` binding, so a launcher-level \`logLevel\` would
   // be discarded. The logger tracks the framework's process-wide threshold, so
   // \`HYDRANIUM_LOG_LEVEL\` ${lsp ? 'and the LSP log-level setting govern' : 'governs'} GLSP output too;
   // pass \`logLevel\` only to make GLSP quieter than the rest of the server.
   createLogger: caller => new GlspClientLogger(shared, { component: caller }),
   serverModule: new ServerModule()${diagrams.map(grammar => `.configureDiagramModule(new ${grammar.grammar}DiagramModule())`).join('')},
   appModules: [new HydraniumGlspAppModule({ shared })],
${
   lsp
      ? `   lspConnection: shared.lsp.Connection,
   portCommand: ${upper}_GLSP_SERVER_PORT_COMMAND`
      : `   workspace,
   port: portFrom('glsp-server-port', ${upper}_GLSP_SERVER_PORT_ENV),
   logger: shared.Logger`
}
});
${lsp ? 'void glspServer;\n' : ''}`
      : '';

   const lspImports = `// The framework's entry point, NOT Langium's \`@hydranium/langium/lsp\` one. It is
// signature-compatible and delegates straight through; what it adds first is
// \`assertLspHeadComposed\`, which fails the start if the LSP head's SHARED module
// was never composed. Reaching for Langium's is the natural mistake and it is
// silent: the server boots, links and completes, while echo suppression, the
// didChangeContent debounce and the last-client-close rebuild are all inert.
import { startLanguageServer, withHydraniumLspFeatures } from '@hydranium/core/lsp';
import { ProposedFeatures, createConnection } from 'vscode-languageserver/node';
`;

   const lspStart = `
const connection = createConnection(withHydraniumLspFeatures(ProposedFeatures.all));
const { shared } = create__NAME__Services({ connection, ...NodeFileSystem });
startLanguageServer(shared);
`;

   // No LSP client names the workspace or asks for the ports here, so the
   // command line does, and the ports go to stdout once every head listens.
   const servers = [...(data ? ['dataServer'] : []), ...(glsp ? ['glspServer'] : [])];
   const socketStart = `
const { values, positionals } = parseArgs({
   options: { ${portFlags.map(flag => `'${flag.slice(2)}': { type: 'string' }`).join(', ')} },
   allowPositionals: true
});
// The workspace root: the first argument, else the process cwd.
const workspace = positionals[0] ?? process.cwd();

/** A head's port: its flag, else its environment variable, else 0 for any free port. */
function portFrom(flag: keyof typeof values, variable: string): number {
   const text = values[flag] ?? process.env[variable] ?? '0';
   const port = Number(text);
   // Decimal digits only: \`Number\` also reads '' as 0 and takes '1e3' or '0x10'.
   if (!/^\\d+$/.test(text) || port > 65_535) {
      throw new Error(\`--\${flag} or \${variable} is '\${text}', not a port\`);
   }
   return port;
}

const { shared } = create__NAME__Services({ ...NodeFileSystem });
`;
   const portsLine = `
// One JSON line on stdout once every head listens, for the process that started
// this one to read the ports from: the one line that starts with \`{\`. Each
// head brings the workspace up before it listens; a head that fails to start
// has logged why and ends the process, which would otherwise serve without it.
${servers.length === 1 ? `${servers[0]}.started` : `Promise.all([${servers.map(server => `${server}.started`).join(', ')}])`}.then(
   () => process.stdout.write(\`\${JSON.stringify({ ${servers.map(server => `${server}: ${server}.port`).join(', ')} })}\\n\`),
   () => process.exit(1)
);
`;

   const invocation = lsp
      ? `// Invocation: \`node lib/main.js --stdio\`, or the package's \`__PROJECT_ID__\` bin
// script.`
      : `// Invocation: \`node lib/main.js [<workspace-path>] ${portFlags.map(flag => `[${flag} <port>]`).join(' ')}\`,
// or the package's \`__PROJECT_ID__\` bin script. Each port falls back to its
// environment variable, then to any free port.`;
   const dataNote = !data
      ? ''
      : lsp
        ? `
//
// NOT the entry the data-server subcommands of \`hydranium-cli\` speak to: stdio
// here carries LSP, and the data head is a socket whose port is published over
// the LSP connection. Those subcommands spawn \`data-server-main.js\`.`
        : `
//
// NOT the entry the data-server subcommands of \`hydranium-cli\` speak to: they
// drive the data protocol over a child's stdio, and the data head here is a
// socket. Those subcommands spawn \`data-server-main.js\`.`;

   const text = `${SHEBANG}// Standalone entry point: starts ${headSummary} in the same
// process, so every head shares one model store.
${invocation}${dataNote}
//
// Everything here runs at module scope, so this file is an executable rather
// than a library entry — import \`./index.js\` instead to compose the language.

${reflectImport}${glspImports}${importList(coreNodeSymbols, '@hydranium/core/node', columns)}
${data ? "import { DataServer } from '@hydranium/data-server';\n" : ''}${data && lsp ? "import { describeErrorWithStack } from '@hydranium/protocol';\n" : ''}${lsp ? lspImports : "import { parseArgs } from 'node:util';\n"}${diagramImports}${transferImports}import { create__NAME__Services } from './language-server/__PROJECT_ID__-module.js';
${portImports === '' ? '' : '\n' + portImports}${lsp ? lspStart : socketStart}${dataBlock}${glspBlock}${lsp ? '' : portsLine}`;
   return project(text, composition);
}

/**
 * The second executable entry: the data head alone, on stdio.
 *
 * Emitted with the `data` head because it is the ONLY command line that reaches
 * that head from outside the editor. `main.ts` serves the data head on a
 * socket, so a client driving the data protocol over a spawned child's
 * stdin/stdout cannot reach it — which is every data-server subcommand of
 * `hydranium-cli`. Without this file a scaffolded project has no `--server`
 * value, and the closest guess, `main.ts`, fails as an unrecognised method or
 * an unknown flag rather than as a missing head.
 *
 * A separate process rather than a flag on `main.ts`: only one protocol can own
 * stdio, so the two entries are mutually exclusive by construction.
 */
function dataServerMainFile(composition: InitComposition): string {
   const columns = columnsFor(composition);
   const roots = composition.grammars.map(grammar => grammar.entryRule).sort();
   const plural = roots.length > 1 ? 's' : '';

   const text = `${SHEBANG}// Standalone entry point: a data-server head on **stdio**, with no LSP head in
// the process. This is the transport \`hydranium-cli\` speaks — its data-server
// subcommands spawn a server command and drive JSON-RPC over its stdin/stdout —
// so it is what makes those subcommands usable against this language.
//
// Invocation: \`node lib/data-server-main.js [<workspace-path>]\`, or the
// package's \`__PROJECT_ID__-data-server\` bin script. The workspace path defaults to
// the process cwd, which is what the CLI's \`--cwd\` sets on the child.
//
${
   composition.heads.includes('lsp')
      ? `// Contrast with \`main.ts\`, the editor entry: there the LSP head owns stdio and
// the data head is a socket published over the LSP connection. Here there is no
// LSP connection at all, so the workspace initialization an
// \`initialize\`/\`initialized\` pair would otherwise drive has to happen here —
// which is why this entry uses \`startStdioServer\` rather than wiring a
// connection directly.`
      : `// Contrast with \`main.ts\`, where the data head is a socket whose port it
// prints. Here it owns stdio, and as there, no LSP connection drives the
// workspace initialization, so \`startStdioServer\` brings the workspace up
// before it listens.`
}
//
// Everything here runs at module scope, so this file is an executable rather
// than a library entry — import \`./index.js\` instead to compose the language.

${importList(['NodeFileSystem', 'startStdioServer'], '@hydranium/core/node', columns)}
import { DataServer } from '@hydranium/data-server';
// The TRANSFER root${plural}, not the AST one${plural} — same reasoning as \`main.ts\`.
${importList(roots, memberPackageName(composition, 'protocol'), columns, true)}
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
import { createServices } from '../src/node/services.js';

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
      const model = transferNode(Transfer__ENTRY_RULE__, {
         nodes: __TRANSFER_NODES__
      });

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
   const transferConstants = composition.grammars.flatMap(grammar => [
      `${grammar.entryRule} as Transfer${grammar.entryRule}`,
      grammar.nodeRule
   ]);
   const suite = (grammar: InitGrammarNames): string => {
      const nodes = [
         `transferNode(${grammar.nodeRule}, { name: 'first', target: 'second' })`,
         `transferNode(${grammar.nodeRule}, { name: 'second' })`
      ];
      const single = `[${nodes.join(', ')}]`;
      const literal =
         `         nodes: ${single}`.length <= columns ? single : `[\n${nodes.map(node => `            ${node}`).join(',\n')}\n         ]`;
      return render(SERIALIZATION_SUITE, composition, grammar).replace('__TRANSFER_NODES__', literal);
   };
   const text = `// Round-trips each grammar through its serializer: parse the source, serialize
// the model, compare the text. The serializer is the parser's inverse, so this
// is the assertion that keeps a client session's \`update\` / \`save\` writing
// files the language server can read back.
//
// The transfer case is the one that catches the mistake worth catching.
// \`ModelService.modelToText\` short-circuits only a RAW STRING, so a typed model
// from the data head reaches \`serializeTransfer\` — where a cross-reference is a
// plain string, not a \`Reference\`.

import { parseHelper } from '@hydranium/core/testing';
import { describe, expect, it } from 'vitest';
${importList(astTypes, '../src/language-server/ast.js', columns, true)}
${importList(transferConstants, memberPackageName(composition, 'protocol'), columns)}
import { createServices } from '../src/node/services.js';
import { transferNode } from './generated-hydranium/transfer-builder.js';

${composition.grammars.map(suite).join('\n\n')}
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
 * The validation tier: the linker's diagnostic for a dangling reference, the
 * tier a new adopter breaks third, and the scaffold's one check, a warning on
 * a repeated name.
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

   it('warns on each node named like one before it', async () => {
      const { shared, __GRAMMAR__ } = createServices();

      const document = await parseHelper<__ENTRY_RULE__>(__GRAMMAR__)('node first\\nnode second\\nnode first', {
         documentUri: 'file:///duplicate.__EXTENSION__'
      });
      await shared.workspace.DocumentBuilder.build([document], { validation: true });

      const diagnostics = document.diagnostics ?? [];
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].severity).toBe(DiagnosticSeverity.Warning);
      expect(diagnostics[0].message).toBe("A node named 'first' is already declared.");
      expect(diagnostics[0].range.start.line).toBe(2);
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
import { createServices } from '../src/node/services.js';

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
// A dangling reference is the FRAMEWORK's own linker diagnostic; a repeated
// name is reported by the scaffold's own validation check. Bind a further
// check in your language module and assert it here alongside these.`;

/** The README, assembled from lines to avoid escaping the Markdown code fences. */
function readme(composition: InitComposition): string {
   const multi = composition.grammars.length > 1;
   const data = composition.heads.includes('data');
   const primaryExtension = composition.grammars[0].extensions[0];
   const diagramCount = composition.grammars.filter(grammar => grammar.diagram).length;
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
      '```bash',
      'npm install',
      'npm run langium:generate   # generate the AST from the grammar',
      'npm run build              # generate + compile to lib/',
      'npm run watch              # regenerate and recompile on every grammar or source change',
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
      'npx hydranium-cli reflect --services ./lib/node/services.js',
      '',
      '# Grammar-convention lint (CI gate)',
      'npx hydranium-cli lint-grammar --services ./lib/node/services.js',
      '',
      '# Validate a workspace of model files (non-zero exit on errors)',
      'npx hydranium-cli validate --services ./lib/node/services.js ../workspace',
      ...(data
         ? [
              '',
              '# Data-head operations. `--server` is a command line the CLI spawns and then',
              "# drives the data protocol over the child's stdin/stdout, so it has to name",
              ...(composition.heads.includes('lsp')
                 ? ['# `data-server-main.js` — `main.js` gives stdio to LSP and answers these', '# methods with "Unhandled method".']
                 : ['# `data-server-main.js` — `main.js` serves the data head on a socket.']),
              '#',
              '# The workspace goes to the ENTRY, not to `--cwd`: `--cwd` re-roots the child,',
              '# so a relative entry path is refused by name (an absolute one is fine).',
              'npx hydranium-cli projects --server "node ./lib/data-server-main.js ../workspace"',
              `npx hydranium-cli query --server "node ./lib/data-server-main.js ../workspace" --uri <file:// URI of ../workspace/nodes.${primaryExtension}>`
           ]
         : []),
      '```',
      '',
      '## Layout',
      '',
      ...grammarBullets,
      ...(multi ? ['- `src/grammar/common.langium` — shared terminals, imported by each grammar (not a language)'] : []),
      '- `src/language-server/__PROJECT_ID__-module.ts` — `create__NAME__Services` DI wiring',
      ...composition.grammars.flatMap(grammar => [
         `- \`src/language-server/${grammar.grammarId}-serializer.ts\` — emits \`${grammar.grammar}\` back to text (the framework defaults this to a throw)`,
         `- \`src/language-server/${grammar.grammarId}-validation.ts\` — the \`${grammar.grammar}\` checks: a warning on a repeated name`
      ]),
      "- `src/node/services.ts` — zero-arg `createServices()` for the headless CLI, the package's `./node` entry",
      `- \`src/index.ts\` — the package root, loadable in a browser worker: DI factory + generated AST${diagramCount === 0 ? '' : diagramCount === 1 ? ' + diagram module' : ' + diagram modules'}`,
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
               `- \`src/glsp/${grammar.grammarId}/\` — the \`${grammar.grammar}\` diagram: state, storage, submission handler, GModel factory, configuration, create-node handler, DI module`
         ),
      `- \`../protocol/\` — the \`${memberPackageName(composition, 'protocol')}\` package: what this server and its clients both import (language ids, ${headPortConstants(composition).length === 0 ? '' : composition.heads.includes('lsp') ? 'port commands, ' : 'port variables, '}${composition.grammars.some(grammar => grammar.diagram) ? 'diagram ids, ' : ''}the transfer model), written partly by \`npm run generate\``,
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
      '`vscode-languageserver` is pinned to `10.1.2`, and',
      '`vscode-languageserver-protocol` and `vscode-jsonrpc` to the `3.18.4` and',
      '`9.0.3` it pins, so Langium, the LSP connection and the framework share one',
      'copy of each. With two, an error a Langium handler returns, such as a request',
      'for a document the server does not have, reaches the client as a result, and a',
      'framework error your own LSP handler throws loses its code.',
      '',
      ...(pinsVitest(composition)
         ? [
              '`vitest` is held below 4.1, whose peer set crashes the npm every Node 22',
              'release bundles. Raise it once every npm that installs this project is',
              '11.6 or later.',
              ''
           ]
         : []),
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
 * Per grammar rather than per project because the state, storage and GModel
 * factory are typed over that grammar's model, and a grammar with no diagram
 * can sit on the same server.
 *
 * The index and the computed-bounds handler are framework classes used
 * unmodified; storage and the submission handler are thin typed subclasses,
 * which is where an adopter's own load/save and log formatting land.
 *
 * The set is EDITABLE rather than read-only: a create-node and a delete handler,
 * registered on the module. GLSP's own `DiagramModule` binds no handler that
 * mutates a source model, so without them the head renders and answers while
 * telling the client it may change nothing — which reads as a broken diagram
 * rather than as a deliberate viewer.
 */
function glspFiles(composition: InitComposition, grammar: InitGrammarNames): InitFile[] {
   const columns = columnsFor(composition);
   const fixed = (file: string): InitFile => grammarTemplate(`server/src/glsp/__GRAMMAR_ID__/${file}`, composition, grammar);
   const computed = (file: string, text: string): InitFile => ({
      path: `server/src/glsp/${grammar.grammarId}/${file}`,
      content: render(text, composition, grammar)
   });

   const configuration = `// Diagram configuration for the __GRAMMAR__ diagram.
//
// **A hint is \`true\` only where a handler backs it.** The starter
// __GRAMMAR__CreateNodeOperationHandler offers creation through the tool palette,
// which GLSP assembles from the create handlers' trigger actions — there is no
// \`creatable\` hint. __GRAMMAR__DeleteOperationHandler backs \`deletable\` on a
// node and an edge; a node of another document stays undeletable, since this
// diagram does not own it. Nothing backs reparent / reposition / resize, so
// declaring one would offer a gesture whose operation the server rejects: a worse
// failure than the tool being absent. Turn a hint on in the same change that adds
// its handler.
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
import { __GRAMMAR_ID_CONST___EDGE_TYPE, __GRAMMAR_ID_CONST___EXTERNAL_NODE_TYPE, __GRAMMAR_ID_CONST___NODE_TYPE } from '__PROTOCOL_PACKAGE__';

@injectable()
export class __GRAMMAR__DiagramConfiguration implements DiagramConfiguration {
   readonly layoutKind: ServerLayoutKind = ServerLayoutKind.NONE;
   readonly needsClientLayout: boolean = true;
   readonly animatedUpdate: boolean = false;

   readonly typeMapping: Map<string, GModelElementConstructor> = getDefaultMapping();

   readonly shapeTypeHints: ShapeTypeHint[] = [
      {
         elementTypeId: __GRAMMAR_ID_CONST___NODE_TYPE,
         deletable: true,
         reparentable: false,
         repositionable: false,
         resizable: false
      },
      {
         elementTypeId: __GRAMMAR_ID_CONST___EXTERNAL_NODE_TYPE,
         deletable: false,
         reparentable: false,
         repositionable: false,
         resizable: false
      }
   ];

   readonly edgeTypeHints: EdgeTypeHint[] = [
      {
         elementTypeId: __GRAMMAR_ID_CONST___EDGE_TYPE,
         deletable: true,
         repositionable: false,
         routable: false,
         sourceElementTypeIds: [__GRAMMAR_ID_CONST___NODE_TYPE],
         targetElementTypeIds: [__GRAMMAR_ID_CONST___NODE_TYPE, __GRAMMAR_ID_CONST___EXTERNAL_NODE_TYPE]
      }
   ];
}
`;

   const module = `// GLSP diagram module for __GRAMMAR__ — the DI wiring of one diagram type.
//
// \`configureActionHandlers\` REBINDS rather than adds: GLSP's own
// \`DiagramModule\` already registers \`ComputedBoundsActionHandler\`, and two
// handlers for one action would both run.
//
// \`configureOperationHandlers\` ADDS: GLSP's default pair
// (\`CompoundOperationHandler\` and \`LayoutOperationHandler\`) mutates no source
// model, so the starter create and delete handlers are what make this diagram
// editable at all.

${importList(
   [
      'ActionHandlerConstructor',
      'BindingTarget',
      'ComputedBoundsAction',
      'DiagramConfiguration',
      'GModelFactory',
      'GModelIndex',
      'GModelRoot',
      'InstanceMultiBinding',
      'ModelState',
      'ModelSubmissionHandler',
      'ModelValidator',
      'OperationHandlerConstructor',
      'SourceModelStorage'
   ],
   '@eclipse-glsp/server',
   columns,
   true
)}
import { ComputedBoundsActionHandler } from '@eclipse-glsp/server';
${importList(
   ['HydraniumGlspComputedBoundsActionHandler', 'AbstractHydraniumGlspDiagramModule', 'HydraniumGlspIndex', 'HydraniumGlspModelValidator'],
   '@hydranium/glsp-server',
   columns
)}
import { __GRAMMAR__CreateNodeOperationHandler } from './create-node-operation-handler.js';
import { __GRAMMAR__DeleteOperationHandler } from './delete-operation-handler.js';
import { __GRAMMAR__DiagramConfiguration } from './diagram-configuration.js';
import { __GRAMMAR__GModelFactory } from './gmodel-factory.js';
import { __GRAMMAR__GlspState } from './state.js';
import { __GRAMMAR__GlspStorage } from './storage.js';
import { __GRAMMAR__SubmissionHandler } from './submission-handler.js';
import { __GRAMMAR_ID_CONST___DIAGRAM_TYPE } from '__PROTOCOL_PACKAGE__';
import { injectable } from 'inversify';

/**
 * The framework handler, keeping none of the edge routes the client reports:
 * it routes an edge before it sizes the nodes, so a self-reference's loop would
 * stay drawn inside its node. The starter's edges have no routing points, and
 * the client routes them afresh from the sized nodes.
 */
@injectable()
export class __GRAMMAR__ComputedBoundsActionHandler extends HydraniumGlspComputedBoundsActionHandler {
   protected override applyBounds(root: GModelRoot, action: ComputedBoundsAction): void {
      super.applyBounds(root, { ...action, routes: undefined });
   }
}

export class __GRAMMAR__DiagramModule extends AbstractHydraniumGlspDiagramModule {
   readonly diagramType = __GRAMMAR_ID_CONST___DIAGRAM_TYPE;

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

   /**
    * The language's diagnostics as diagram markers, following each edit. GLSP
    * binds no validator by default, and without one no marker ever shows.
    */
   protected override bindModelValidator(): BindingTarget<ModelValidator> {
      return HydraniumGlspModelValidator;
   }

   protected override configureActionHandlers(binding: InstanceMultiBinding<ActionHandlerConstructor>): void {
      super.configureActionHandlers(binding);
      binding.rebind(ComputedBoundsActionHandler, __GRAMMAR__ComputedBoundsActionHandler);
   }

   protected override configureOperationHandlers(binding: InstanceMultiBinding<OperationHandlerConstructor>): void {
      super.configureOperationHandlers(binding);
      binding.add(__GRAMMAR__CreateNodeOperationHandler);
      binding.add(__GRAMMAR__DeleteOperationHandler);
   }
}
`;

   return [
      fixed('state.ts'),
      fixed('storage.ts'),
      fixed('submission-handler.ts'),
      fixed('gmodel-factory.ts'),
      computed('diagram-configuration.ts', configuration),
      fixed('create-node-operation-handler.ts'),
      fixed('delete-operation-handler.ts'),
      computed('diagram-module.ts', module),
      grammarTemplate('server/test/__GRAMMAR_ID__-diagram.test.ts', composition, grammar)
   ];
}

/**
 * The server member: the grammar, the language and its heads.
 *
 * Grammar-count-dependent emissions live here rather than in a template string:
 * one `.langium` file per grammar, and the shared `common.langium` fragment only
 * when there is more than one grammar to share it.
 */
function serverFiles(composition: InitComposition): InitFile[] {
   const multi = composition.grammars.length > 1;
   const grammarFiles: InitFile[] = composition.grammars.map(grammar => ({
      path: `server/src/grammar/${grammar.grammarId}.langium`,
      content: render(grammarFile(multi), composition, grammar)
   }));
   // The shared lexical fragment, only for several grammars: each declaring its
   // own `WS` / `ID` lets the token sets drift apart.
   if (multi) {
      grammarFiles.unshift(projectTemplate('server/src/grammar/common.langium', composition));
   }

   const diagramFiles = composition.grammars.filter(grammar => grammar.diagram).flatMap(grammar => glspFiles(composition, grammar));

   return [
      { path: 'server/package.json', content: packageJson(composition) },
      { path: 'server/langium-config.json', content: langiumConfig(composition) },
      { path: 'server/tsconfig.json', content: serverTsconfigJson(composition) },
      // `isolatedModules` is what makes this check agree with the transform that
      // actually runs the tests. `npm test` is `typecheck:test && vitest run`, and
      // vitest compiles each file on its own — a transform with no type
      // information, which cannot tell a re-exported TYPE from a re-exported value.
      // Without the flag `tsc` accepts `export { SomeType } from './x'` that the
      // transform then emits as a real import of a symbol that does not exist at
      // runtime, so the typecheck passes and the suite fails with a confusing
      // missing-export.
      projectTemplate('server/tsconfig.test.json', composition),
      // Found by name, unlike `tsconfig.test.json`. Under vite 8, vitest's transform
      // applies a tsconfig only to the files its own `include` lists, so without this
      // a test declaring a decorated class fails to load.
      projectTemplate('server/test/tsconfig.json', composition),
      projectTemplate('server/vitest.config.ts', composition),
      // Written for a workspace member too: its root may not ignore `lib/` (a `yo
      // langium` root ignores `out/`), and a rule the root repeats costs nothing.
      ignoreFile('server'),
      { path: 'server/README.md', content: readme(composition) },
      ...grammarFiles,
      { path: `server/src/language-server/${composition.projectId}-module.ts`, content: moduleFile(composition) },
      grammarTemplate('server/src/language-server/ast.ts', composition, composition.grammars[0]),
      // Per grammar, because `services.serializer.Serializer` is a per-language slot
      // and a serializer is grammar-shaped by definition. That is also why the
      // framework refuses to default it: its `UnboundSerializer` throws, naming the
      // binding to add, rather than guessing a syntax.
      ...composition.grammars.flatMap(grammar => [
         grammarTemplate('server/src/language-server/__GRAMMAR_ID__-serializer.ts', composition, grammar),
         grammarTemplate('server/src/language-server/__GRAMMAR_ID__-validation.ts', composition, grammar)
      ]),
      { path: 'server/src/index.ts', content: indexFile(composition) },
      projectTemplate('server/src/node/services.ts', composition),
      { path: 'server/src/main.ts', content: mainFile(composition) },
      ...(composition.heads.includes('data') ? [{ path: 'server/src/data-server-main.ts', content: dataServerMainFile(composition) }] : []),
      ...diagramFiles,
      { path: 'server/test/services.test.ts', content: servicesTest(composition) },
      { path: 'server/test/parsing.test.ts', content: grammarTest(composition, PARSING_HEADER, [], PARSING_SUITE) },
      {
         path: 'server/test/linking.test.ts',
         content: grammarTest(composition, LINKING_HEADER, ["import { AstUtils } from '@hydranium/langium';"], LINKING_SUITE)
      },
      {
         path: 'server/test/validating.test.ts',
         content: grammarTest(
            composition,
            VALIDATING_HEADER,
            ["import { DiagnosticSeverity } from 'vscode-languageserver';"],
            VALIDATING_SUITE
         )
      },
      { path: 'server/test/serialization.test.ts', content: serializationTest(composition) }
   ];
}

/**
 * The protocol member's `package.json`.
 *
 * Its `build` runs the server's `generate` first, because the server writes
 * this package's `generated-hydranium/` modules from the grammar: a runner that
 * builds in dependency order reaches this package before the server, and would
 * otherwise compile modules that do not exist yet. A full build therefore
 * generates twice; the second pass rewrites nothing.
 */
function protocolPackageJson(composition: InitComposition): string {
   const member = forMember(composition, 'protocol');
   const dependencies: Record<string, string> = {};
   for (const head of composition.heads) {
      Object.assign(dependencies, PROTOCOL_THIRD_PARTY_DEPENDENCIES[head]);
   }
   const dependencyLines =
      Object.keys(dependencies).length === 0 ? '' : `  "dependencies": {\n${sortedBlock(dependencies, '    ')}\n  },\n`;
   return `{
  "name": "${memberPackageName(composition, 'protocol')}",
  "version": "0.0.0",
${composition.packaging.private ? '  "private": true,\n' : ''}  "description": "What the ${composition.name} language server and its clients share: language ids, wire types and diagram ids.",
  "license": "UNLICENSED",
  "author": "",
  "files": [
    "lib",
    "src"
  ],
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "scripts": {
    "build": "npm --prefix ../server run generate && tsc -b",
    "clean": "rimraf lib tsconfig.tsbuildinfo",
${lintScript(member, 'src')}    "watch": "tsc -b --watch"
  },
${dependencyLines}  "devDependencies": {
    "rimraf": "^5.0.0",
    "typescript": "^7.0.2"
  },
  "engines": {
    "node": ">=22.13"
  }
}
`;
}

/** The protocol member's root entry, one re-export per module. */
function protocolIndexFile(composition: InitComposition): string {
   const modules = [
      './generated-hydranium/languages.js',
      './generated-hydranium/transfer-model.js',
      ...(headPortConstants(composition).length ? ['./head-ports.js'] : []),
      ...composition.grammars.filter(grammar => grammar.diagram).map(grammar => `./${grammar.grammarId}-diagram-types.js`)
   ];
   const text = `// What the __NAME__ server and its clients both import. A client depends on
// this package instead of the server, so it never installs Langium to reach a
// constant or a wire type.
//
// The server's \`generate\` writes \`generated-hydranium/\` from the grammar;
// commit those modules with the grammar change that produced them. An interface
// narrowed here hides the generated constant of the same name; re-export that
// constant beside it, and declare the type map under its own name with the
// narrowed entry, or the builder and the GLSP state keep the generated one.

${modules.map(module => `export * from '${module}';`).join('\n')}
`;
   return project(text, composition);
}

/** The protocol member's README. */
function protocolReadme(composition: InitComposition): string {
   const lines = [
      `# ${memberPackageName(composition, 'protocol')}`,
      '',
      'What the __NAME__ language server and its clients both import, so a client',
      'never depends on the server or installs Langium.',
      '',
      '- `src/generated-hydranium/languages.ts` — each language id and its file extensions',
      '- `src/generated-hydranium/transfer-model.ts` — the wire types of the model, references as plain strings',
      ...(headPortConstants(composition).length === 0
         ? []
         : composition.heads.includes('lsp')
           ? ['- `src/head-ports.ts` — the LSP requests a host sends to find the socket heads']
           : ["- `src/head-ports.ts` — the environment variables naming the socket heads' ports"]),
      ...composition.grammars
         .filter(grammar => grammar.diagram)
         .map(grammar => `- \`src/${grammar.grammarId}-diagram-types.ts\` — the \`${grammar.grammar}\` diagram's type ids`),
      '',
      "The server's `npm run generate` writes `src/generated-hydranium/` from the",
      'grammar, and `npm run build` here runs it first. Commit the generated',
      'modules with the grammar change that produced them.',
      ''
   ];
   return project(lines.join('\n'), composition);
}

/** The protocol member: everything the server and its clients both import. */
function protocolFiles(composition: InitComposition): InitFile[] {
   return [
      { path: 'protocol/package.json', content: protocolPackageJson(composition) },
      { path: 'protocol/tsconfig.json', content: tsconfigJson(forMember(composition, 'protocol'), PROTOCOL_COMPILER_OPTIONS, '["src"]') },
      ignoreFile('protocol'),
      { path: 'protocol/README.md', content: protocolReadme(composition) },
      { path: 'protocol/src/index.ts', content: protocolIndexFile(composition) },
      ...(headPortConstants(composition).length ? [{ path: 'protocol/src/head-ports.ts', content: headPortsFile(composition) }] : []),
      ...composition.grammars
         .filter(grammar => grammar.diagram)
         .map(grammar => grammarTemplate('protocol/src/__GRAMMAR_ID__-diagram-types.ts', composition, grammar))
   ];
}

/**
 * The starter model files every host and the CLI open, two per language: one
 * declaring nodes, one referencing a node in the other file.
 *
 * Named by extension alone, since `init` refuses two grammars sharing one.
 */
function workspaceFiles(composition: InitComposition): InitFile[] {
   return composition.grammars.flatMap(grammar => [
      grammarTemplate('workspace/nodes.__EXTENSION__', composition, grammar),
      grammarTemplate('workspace/references.__EXTENSION__', composition, grammar)
   ]);
}

/** The client member's compiler options: the protocol's, with the DOM its diagram renders into. */
const CLIENT_COMPILER_OPTIONS: ReadonlyArray<readonly [string, JsonValue]> = [
   ['target', 'ES2022'],
   ['lib', ['ES2022', 'DOM']],
   ['module', 'NodeNext'],
   ['moduleResolution', 'NodeNext'],
   ['rootDir', 'src'],
   ['outDir', 'lib'],
   ['strict', true],
   ['skipLibCheck', true],
   ['declaration', true],
   // For inversify's `@injectable`, which a GLSP view needs to be bound.
   ['experimentalDecorators', true],
   ['types', []],
   // A base that sets it fails every `import` in this CommonJS member.
   ['verbatimModuleSyntax', false]
];

/**
 * The client member's `package.json`.
 *
 * CommonJS, unlike its siblings, as GLSP's client is: inversify ships an ES
 * build and a CommonJS one, so an ES module here would load the first while
 * GLSP's client loads the second, giving a page two containers' worth of
 * classes. Node from 22.12 and `tsc` under `nodenext` both let it require the
 * ES protocol member.
 */
function clientPackageJson(composition: InitComposition): string {
   const dependencies: Record<string, string> = {
      [memberPackageName(composition, 'protocol')]: MEMBER_PIN,
      ...CLIENT_THIRD_PARTY_DEPENDENCIES
   };
   for (const framework of CLIENT_FRAMEWORK_DEPENDENCIES) {
      dependencies[framework] = frameworkPin(composition);
   }
   return `{
  "name": "${memberPackageName(composition, 'client')}",
  "version": "0.0.0",
${composition.packaging.private ? '  "private": true,\n' : ''}  "description": "The host-neutral client side of the ${composition.name} language: what every host of it mounts.",
  "license": "UNLICENSED",
  "author": "",
  "files": [
    "lib",
    "src"
  ],
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "scripts": {
    "build": "tsc -b",
    "clean": "rimraf lib tsconfig.tsbuildinfo",
${lintScript(forMember(composition, 'client'), 'src')}    "watch": "tsc --watch"
  },
  "dependencies": {
${sortedBlock(dependencies, '    ')}
  },
  "devDependencies": {
    "rimraf": "^5.0.0",
    "typescript": "^7.0.2"
  },
  "engines": {
    "node": ">=22.13"
  }
}
`;
}

/** The client member's README. */
function clientReadme(composition: InitComposition): string {
   const diagrams = composition.grammars.filter(grammar => grammar.diagram);
   const lines = [
      `# ${memberPackageName(composition, 'client')}`,
      '',
      'The host-neutral client side of the __NAME__ language: what every host of it',
      'mounts, whatever that host is. It reads the element ids from the protocol',
      'package and never depends on the server.',
      '',
      ...diagrams.map(
         grammar =>
            `- \`src/${grammar.grammarId}-diagram-module.ts\` — the \`${grammar.grammar}\` diagram: a registration per element type, its container module, and \`initialize${grammar.grammar}DiagramContainer\``
      ),
      '- `src/index.ts` — the package root, re-exporting each module',
      '',
      'A host builds a diagram container with the initializer, passing its own',
      'modules: they go first and the diagram definition last, since GLSP gives an',
      'element type to whichever module registered it last.',
      ''
   ];
   return project(lines.join('\n'), composition);
}

/** The client member's root entry, one re-export per diagram module. */
function clientIndexFile(composition: InitComposition): string {
   const modules = composition.grammars.filter(grammar => grammar.diagram).map(grammar => `./${grammar.grammarId}-diagram-module.js`);
   return `// What every host of the ${composition.name} language mounts.

${modules.map(module => `export * from '${module}';`).join('\n')}
`;
}

/**
 * The client member: the host-neutral client side of the language, emitted
 * when there is a diagram to define. Each host mounts it rather than defining
 * the diagram again.
 */
function clientFiles(composition: InitComposition): InitFile[] {
   return [
      { path: 'client/package.json', content: clientPackageJson(composition) },
      {
         path: 'client/tsconfig.json',
         content: tsconfigJson(forMember(composition, 'client'), CLIENT_COMPILER_OPTIONS, '["src"]', '[{ "path": "../protocol" }]')
      },
      ignoreFile('client'),
      { path: 'client/README.md', content: clientReadme(composition) },
      { path: 'client/src/index.ts', content: clientIndexFile(composition) },
      ...composition.grammars
         .filter(grammar => grammar.diagram)
         .map(grammar => grammarTemplate('client/src/__GRAMMAR_ID__-diagram-module.ts', composition, grammar))
   ];
}

/**
 * The browser host's `package.json`. Always private: it is an application,
 * which nothing installs as a dependency.
 */
function hostBrowserPackageJson(composition: InitComposition): string {
   const dependencies: Record<string, string> = {
      [memberPackageName(composition, 'protocol')]: MEMBER_PIN,
      [memberPackageName(composition, 'server')]: MEMBER_PIN,
      ...(composition.heads.includes('glsp') ? { [memberPackageName(composition, 'client')]: MEMBER_PIN } : {}),
      // A page with no editor saves through the diagram's own action dispatcher.
      ...(composition.heads.includes('lsp') ? {} : { '@eclipse-glsp/client': CLIENT_THIRD_PARTY_DEPENDENCIES['@eclipse-glsp/client'] })
   };
   for (const head of ['base', ...composition.heads] as const) {
      Object.assign(dependencies, HOST_BROWSER_THIRD_PARTY_DEPENDENCIES[head]);
      for (const framework of HOST_BROWSER_FRAMEWORK_DEPENDENCIES[head]) {
         dependencies[framework] = frameworkPin(composition);
      }
   }
   return `{
  "name": "${memberPackageName(composition, 'host-browser')}",
  "version": "0.0.0",
  "private": true,
  "description": "${composition.name} in a browser page, with every head in a web worker and no backend.",
  "license": "UNLICENSED",
  "author": "",
  "type": "module",
  "scripts": {
    "build": "npm run typecheck && node esbuild.mjs",
    "clean": "rimraf out test-results playwright-report",
${lintScript(forMember(composition, 'host-browser'), 'src test')}    "start": "node esbuild.mjs --serve",
    "test:e2e": "playwright test --tsconfig tsconfig.e2e.json",
    "test:e2e:install": "playwright install chromium",
    "typecheck": "tsc --noEmit -p tsconfig.worker.json && tsc --noEmit -p tsconfig.page.json && tsc --noEmit -p tsconfig.e2e.json"
  },
  "dependencies": {
${sortedBlock(dependencies, '    ')}
  },
  "devDependencies": {
${sortedBlock(HOST_BROWSER_DEV_DEPENDENCIES, '    ')}
  },
  "engines": {
    "node": ">=22.13"
  }
}
`;
}

/** The workspace URI of a grammar's first starter file, as a template literal over `WORKSPACE_ROOT_URI`. */
function starterUri(grammar: InitGrammarNames): string {
   return `\`\${WORKSPACE_ROOT_URI}/nodes.${grammar.extensions[0]}\``;
}

/**
 * The worker hosting the heads: every head over the one store, with the
 * workspace seeded from `../workspace` and saved files kept in IndexedDB.
 */
function hostWorkerFile(composition: InitComposition): string {
   const columns = columnsFor(composition);
   const lsp = composition.heads.includes('lsp');
   const data = composition.heads.includes('data');
   const glsp = composition.heads.includes('glsp');
   const diagrams = composition.grammars.filter(grammar => grammar.diagram);
   const roots = composition.grammars.map(grammar => grammar.entryRule).sort();
   const serverSymbols = [`create${composition.name}Services`, ...diagrams.map(grammar => `${grammar.grammar}DiagramModule`)].sort(
      (left, right) => left.localeCompare(right)
   );

   const imports = [
      ...(glsp
         ? [
              '// First, before any class carrying a decorator loads: GLSP reads the metadata',
              '// its decorators emit as each class is defined.',
              "import 'reflect-metadata';",
              "import { ServerModule } from '@eclipse-glsp/server/browser.js';"
           ]
         : []),
      "import { persistentFileSystem } from '@hydranium/core';",
      importList(
         ['hostHeadsInWorker', 'IndexedDbFileSystemStore', ...(lsp ? ['startLanguageServerInWorker'] : [])],
         '@hydranium/core/browser',
         columns
      ),
      ...(data
         ? [
              "import { DataServer } from '@hydranium/data-server';",
              "import { startDataServerInWorker } from '@hydranium/data-server/browser';"
           ]
         : []),
      ...(glsp
         ? [
              "import { GlspClientLogger, HydraniumGlspAppModule } from '@hydranium/glsp-server';",
              "import { startGlspServerInWorker } from '@hydranium/glsp-server/browser';"
           ]
         : []),
      ...(data ? [importList(roots, memberPackageName(composition, 'protocol'), columns, true)] : []),
      importList(serverSymbols, memberPackageName(composition, 'server'), columns),
      "import { WORKSPACE_ROOT_URI } from './workspace.js';"
   ];

   const services = `const shared = create${composition.name}Services({ ...fileSystem }).shared;`;
   const lspCall = `startLanguageServerInWorker(ports.lsp, connection => create${composition.name}Services({ connection, ...fileSystem }).shared);`;
   const startServices = !lsp
      ? services
      : `      const shared = ${lspCall}`.length <= columns
        ? `const shared = ${lspCall}`
        : `const shared = startLanguageServerInWorker(
         ports.lsp,
         connection => create${composition.name}Services({ connection, ...fileSystem }).shared
      );`;
   const dataServer = `connection => new DataServer<${roots.join(' | ')}>(connection, shared)`;
   const dataCall = `startDataServerInWorker(ports.data, shared, ${dataServer});`;
   const dataHead = data
      ? `
      // The data head serves from the ${lsp ? "LSP head's" : "services'"} store, on its own port.
      ${
         `      ${dataCall}`.length <= columns
            ? dataCall
            : `startDataServerInWorker(
         ports.data,
         shared,
         ${dataServer}
      );`
      }`
      : '';
   const glspHead = glsp
      ? `
      const glsp = startGlspServerInWorker({
         context: ports.glsp,
         createLogger: caller => new GlspClientLogger(shared, { component: caller }),
         serverModule: new ServerModule()${diagrams.map(grammar => `.configureDiagramModule(new ${grammar.grammar}DiagramModule())`).join('')},
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      // The GLSP head reports a failed start through \`started\`, which the
      // ready message waits for.
      return { shared, started: [glsp.started] };`
      : `
      return shared;`;

   const text = `// The worker hosting the heads: every head over one store, in the browser and
// with no backend. The page reaches each head over a \`MessagePort\` of its own.

${imports.join('\n')}

/** The files of \`../workspace\`, read by \`esbuild.mjs\` and keyed by their path below the root. */
declare const __WORKSPACE_SEED__: Record<string, string>;
/** This project's directory, hashed by \`esbuild.mjs\`, so that no other project on the origin opens its store. */
declare const __DIRECTORY_KEY__: string;

// A saved file is kept in IndexedDB and laid over the seed on the next load;
// the heads start once the stored files are restored.
const store = new IndexedDbFileSystemStore(\`__PROJECT_ID__-workspace-\${__DIRECTORY_KEY__}\`);

hostHeadsInWorker(
   persistentFileSystem({ store, seed: __WORKSPACE_SEED__, rootUri: WORKSPACE_ROOT_URI }),
   (ports, fileSystem) => {
      ${lsp ? '// The LSP head composes the services, as the Node entry does around stdio.\n      ' : ''}${startServices}${dataHead}${glspHead}
   },
   ${
      lsp
         ? '// The ready message then carries the workspace files the page opens.'
         : '// With no LSP head the workspace comes up from this root, and the ready\n   // message then carries its files.'
   }
   { rootUri: WORKSPACE_ROOT_URI }
);
`;
   return project(text, composition);
}

/**
 * The page, and the one place deciding which head's part of it runs: each
 * part is a module of its own, and this calls the ones the heads serve.
 */
function hostPageFile(composition: InitComposition): string {
   const lsp = composition.heads.includes('lsp');
   const data = composition.heads.includes('data');
   const diagram = composition.grammars.find(grammar => grammar.diagram);
   // A host takes lsp or glsp, and glsp marks a diagram grammar, so without lsp there is one.
   const diagramLanguage = lsp || diagram === undefined ? undefined : `${screamingSnake(diagram.grammarId)}_LANGUAGE`;
   const shownLanguage = diagramLanguage ?? 'ALL_LANGUAGES';
   const parts = [
      // Every part follows the file the page shows, so the switch comes first. With
      // no editor it lists only the diagram's files, the only ones the page shows.
      {
         module: './shown-file.js',
         imports: 'startShownFile',
         call: `const shownFile = await startShownFile(heads, ${diagramLanguage === undefined ? shownLanguage : `[${diagramLanguage}]`});`
      },
      // Save is armed with the editor, so it works before the other panes load;
      // with a diagram it waits for the edits of the one shown, once mounted.
      ...(lsp
         ? [
              {
                 module: './editor.js',
                 imports: 'armEditorSave, startEditor',
                 call: [
                    'const editor = await startEditor(heads, shownFile);',
                    ...(diagram === undefined
                       ? ['armEditorSave(editor);']
                       : [
                            'let shownDiagram: Awaited<ReturnType<typeof mountDiagram>> | undefined = undefined;',
                            'armEditorSave(editor, () => settleDiagramEdits(shownDiagram?.()));'
                         ])
                 ].join('\n   ')
              }
           ]
         : []),
      ...(data
         ? [
              {
                 module: './data-status.js',
                 imports: 'showDataStatus',
                 call: `await showDataStatus(heads.data, ${starterUri(composition.grammars[0])});`
              }
           ]
         : []),
      ...(diagram === undefined
         ? []
         : [
              {
                 module: './diagram.js',
                 imports: lsp ? 'mountDiagram, settleDiagramEdits' : 'mountDiagram',
                 call: `${lsp ? 'shownDiagram' : 'const shownDiagram'} = await mountDiagram(heads.glsp, shownFile, logger, ${lsp ? 'settleDiagramEdits' : 'saveBeforeLeaving'});`
              }
           ]),
      // Without the editor, the diagram is what the page saves through.
      ...(lsp ? [] : [{ module: './diagram-save.js', imports: 'armDiagramSave, saveBeforeLeaving', call: 'armDiagramSave(shownDiagram);' }])
   ];
   const imports = [
      ...parts.map(part => `import { ${part.imports} } from '${part.module}';`),
      "import { appendLog, setStatus } from './log.js';",
      ...(data ? ["import { WORKSPACE_ROOT_URI } from './workspace.js';"] : [])
   ].sort((left, right) => left.slice(left.indexOf("'")).localeCompare(right.slice(right.indexOf("'"))));

   return `// The page: it starts the worker, hands each head a channel of its own, and
// fills the pane of each head the server runs, one after the other.

import { connectWorkerHeads } from '@hydranium/client-browser';
import { ConsoleLogger, describeError } from '@hydranium/protocol';
import { ${shownLanguage} } from '${memberPackageName(composition, 'protocol')}';
${imports.join('\n')}

/** Where the worker bundle is served, substituted by \`esbuild.mjs\`. */
declare const __WORKER_BUNDLE_URL__: string;

async function main(): Promise<void> {
   // The page's end of each head's connection logs to the browser console.
   const logger = new ConsoleLogger();
   const heads = connectWorkerHeads(new Worker(__WORKER_BUNDLE_URL__), { logger });
   heads.onWorkerError(report => appendLog(\`worker error during \${report.phase}: \${report.message}\`));
   setStatus('starting…');
${parts.map(part => `   ${part.call}`).join('\n')}
   setStatus('ready');
}

main().catch((error: unknown) => setStatus(\`failed: \${describeError(error)}\`));
`;
}

/**
 * The smoke test: what each head shows on the page, and an edit that survives
 * a reload, typed in the editor or, with no LSP head, made in the diagram. With
 * a diagram, also a diagram edit the reload guard and Save catch before the
 * server has answered it.
 */
function hostSmokeSpec(composition: InitComposition): string {
   const lsp = composition.heads.includes('lsp');
   const data = composition.heads.includes('data');
   const diagram = composition.grammars.find(grammar => grammar.diagram);
   const primary = composition.grammars[0];
   const checks = [
      ...(lsp ? ["   await expect(editor).toContainText('node First');"] : []),
      ...(data
         ? [
              '   // The data head reads the document out of the same store.',
              `   await expect(page.locator('#data-status')).toHaveText('data head: nodes.${primary.extensions[0]} holds a ${primary.entryRule}');`
           ]
         : []),
      ...(diagram === undefined
         ? []
         : [
              '   // The diagram follows the switch: two nodes in one file, and in the other its',
              '   // node and the target it references there, drawn as external.',
              "   const first = await page.locator('#file').inputValue();",
              `   await page.locator('#file').selectOption('nodes.${diagram.extensions[0]}');`,
              "   await expect(page.locator('#diagram .sprotty-node')).toHaveCount(2);",
              `   await page.locator('#file').selectOption('references.${diagram.extensions[0]}');`,
              `   await expect(page.locator('#diagram .external')).toHaveText('Second (nodes.${diagram.extensions[0]})');`,
              "   await page.locator('#file').selectOption(first);"
           ])
   ];
   const edit = lsp
      ? `   await editor.click();
   await page.keyboard.press('ControlOrMeta+End');
   await page.keyboard.type('\\nnode Added');
   await page.locator('#save').click();
   await expect(page.locator('#status')).toHaveText('saved 1 file(s)');

   await page.reload();
   await expect(page.locator('#status')).toHaveText('ready');
   await expect(editor).toContainText('node Added');`
      : `   // A node from the palette, dropped low and left of centre: the starter nodes
   // sit in the upper band and the palette in the upper right.
   const canvas = page.locator('#diagram');
   const create = async (): Promise<void> => {
      await page.locator('#diagram .tool-button', { hasText: '${diagram?.nodeRule}' }).click();
      const size = await canvas.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
      await canvas.click({ position: { x: size.width * 0.4, y: size.height * 0.85 } });
   };
   await create();
   await expect(nodes).toHaveCount(3);
   await page.locator('#save').click();
   await expect(page.locator('#status')).toHaveText('saved the diagram');
   // A second, left unsaved: the switch saves the diagram it leaves.
   await create();
   await expect(nodes).toHaveCount(4);
   await page.locator('#file').selectOption('references.${diagram?.extensions[0]}');
   await expect(page.locator('#diagram .external')).toBeVisible();

   await page.reload();
   await expect(page.locator('#status')).toHaveText('ready');
   await expect(nodes).toHaveCount(4);`;
   const guardTest =
      diagram === undefined
         ? ''
         : `
test('asks before a reload drops a diagram edit the server has not answered, and saves it with Save at once', async ({ page }) => {
   const nodes = page.locator('#diagram .sprotty-node');
   const askGuard = (): Promise<boolean> =>
      page.evaluate(() => {
         const event = new Event('beforeunload', { cancelable: true });
         window.dispatchEvent(event);
         return event.defaultPrevented;
      });
   await page.goto('/');
   await expect(page.locator('#status')).toHaveText('ready');
   await page.locator('#file').selectOption('nodes.${diagram.extensions[0]}');
   await expect(nodes).toHaveCount(2);

   const canvas = page.locator('#diagram');
   await page.locator('#diagram .tool-button', { hasText: '${diagram.nodeRule}' }).click();
   const size = await canvas.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
   // Asked and clicked right after the click's own handlers, in the same turn
   // of the page, so the server's answer cannot have marked anything unsaved.
   await page.evaluate(() => {
      window.addEventListener(
         'mouseup',
         () =>
            queueMicrotask(() => {
               const event = new Event('beforeunload', { cancelable: true });
               window.dispatchEvent(event);
               document.getElementById('save')?.click();
               Reflect.set(window, 'guardedOnCreate', event.defaultPrevented);
            }),
         { once: true }
      );
   });
   await canvas.click({ position: { x: size.width * 0.4, y: size.height * 0.85 } });
   expect(await page.evaluate(() => Reflect.get(window, 'guardedOnCreate'))).toBe(true);
   await expect(page.locator('#status')).toHaveText('${lsp ? 'saved 1 file(s)' : 'saved the diagram'}');
   expect(await askGuard()).toBe(false);

   await page.reload();
   await expect(page.locator('#status')).toHaveText('ready');
   await page.locator('#file').selectOption('nodes.${diagram.extensions[0]}');
   await expect(nodes).toHaveCount(3);
});
`;
   const locators = [
      ...(lsp ? ["   const editor = page.locator('#editor .view-lines');"] : []),
      ...(lsp ? [] : ["   const nodes = page.locator('#diagram .sprotty-node');"])
   ];
   return `// The page loads with every head answering, and an edit saved through the
// ${lsp ? 'LSP head' : 'GLSP head'} is still there after a reload; any console error fails that
// test. The other asks before a reload drops a diagram edit the server has not
// answered yet, and keeps it when Save is clicked at once.

import { expect, test } from '@playwright/test';

test('loads every head and keeps a saved ${lsp ? 'edit' : 'diagram edit'} across a reload', async ({ page }) => {
   const errors: string[] = [];
   page.on('pageerror', error => errors.push(error.message));
   page.on('console', message => {
      if (message.type() === 'error') {
         errors.push(message.text());
      }
   });
${locators.join('\n')}

   await page.goto('/');
   await expect(page.locator('#status')).toHaveText('ready');
${checks.join('\n')}

${edit}
   expect(errors).toEqual([]);
});
${guardTest}`;
}

/** The browser host's README. */
function hostBrowserReadme(composition: InitComposition): string {
   const lsp = composition.heads.includes('lsp');
   const data = composition.heads.includes('data');
   const diagram = composition.grammars.find(grammar => grammar.diagram);
   const lines = [
      `# ${memberPackageName(composition, 'host-browser')}`,
      '',
      '__NAME__ in a browser page: every head runs in a web worker, with no backend',
      `and no Node runtime. The page saves through the ${lsp ? 'LSP head' : 'GLSP head'}, and the worker`,
      'keeps each saved file in IndexedDB, laid over `../workspace` on the next',
      'load.',
      '',
      '```bash',
      'npm run build              # type-check and bundle into out/',
      'npm start                  # serve the page at the URL it prints, rebundled on every source change',
      'npm run test:e2e:install   # download the Chromium the smoke test drives, once',
      'npm run test:e2e           # the smoke test, which serves the page itself',
      '```',
      '',
      '`PORT` moves the page to another port, for `npm start` and the smoke test alike;',
      'stop `npm start` before the smoke test, or give one of them another port.',
      '`npm start` reads `../workspace` once, so restart it after editing a file',
      'there.',
      '',
      '## Layout',
      '',
      '- `index.html` — the page, with a pane for each head that stays hidden until its part fills it',
      '- `hydranium-mark.svg` — the tab icon',
      `- \`esbuild.mjs\` — bundles the page${lsp ? ', the worker and Monaco’s worker' : ' and the worker'}, reading \`../workspace\` in as the seed`,
      '- `src/worker.ts` — the worker: the heads over one store, seeded and persisted',
      '- `src/page.ts` — starts the worker and runs the part of the page each head serves',
      '- `src/shown-file.ts` — the file switch above the panes, which every part follows',
      ...(lsp ? ['- `src/editor.ts` — the LSP part: a Monaco editor and Save'] : []),
      ...(data ? ['- `src/data-status.ts` — the data part: one document read through the data head'] : []),
      ...(diagram === undefined
         ? []
         : [
              `- \`src/diagram.ts\` — the GLSP part: the \`${diagram.grammar}\` diagram of the file the page shows, defined in the client package`
           ]),
      ...(lsp ? [] : ['- `src/diagram-save.ts` — Save with no editor: the diagram saved through the GLSP head']),
      '- `src/log.ts` — the status line and the log area',
      '- `src/workspace.ts` — the workspace root URI both ends name',
      ...(lsp ? ['- `src/monaco-editor-worker.ts` — Monaco’s own worker, which hosts no head'] : []),
      '- `src/posix-path-shim.ts` — the `path` function the framework imports, for the bundle',
      '- `test/smoke.spec.mts` — the page loads, each head answers, and a saved edit survives a reload',
      ''
   ];
   return project(lines.join('\n'), composition);
}

/** The page with the line under its log view saying what shows there, which the LSP head decides. */
function withLogHint(page: InitFile, lsp: boolean): InitFile {
   const hint = lsp
      ? 'What the server logs over the LSP head, and the errors the page reports.'
      : "The errors the page reports. The server logs to the worker's console, in the browser's developer tools.";
   return { ...page, content: page.content.replace('__LOG_HINT__', hint) };
}

/** The browser host: a page and a worker, bundled by esbuild and served as static files. */
function hostBrowserFiles(composition: InitComposition): InitFile[] {
   const fixed = (file: string): InitFile => projectTemplate(`host-browser/${file}`, composition);
   const lsp = composition.heads.includes('lsp');
   const diagram = composition.grammars.find(grammar => grammar.diagram);
   return [
      { path: 'host-browser/package.json', content: hostBrowserPackageJson(composition) },
      ignoreFile('host-browser'),
      { path: 'host-browser/README.md', content: hostBrowserReadme(composition) },
      withLogHint(fixed('index.html'), lsp),
      fixed('hydranium-mark.svg'),
      fixed('esbuild.mjs'),
      fixed('playwright.config.mts'),
      fixed('tsconfig.worker.json'),
      fixed('tsconfig.page.json'),
      fixed('tsconfig.e2e.json'),
      { path: 'host-browser/src/worker.ts', content: hostWorkerFile(composition) },
      { path: 'host-browser/src/page.ts', content: hostPageFile(composition) },
      fixed('src/shown-file.ts'),
      ...(lsp ? [fixed('src/editor.ts')] : []),
      ...(composition.heads.includes('data') ? [fixed('src/data-status.ts')] : []),
      ...(diagram === undefined ? [] : [grammarTemplate('host-browser/src/diagram.ts', composition, diagram)]),
      ...(lsp ? [] : [fixed('src/diagram-save.ts')]),
      fixed('src/log.ts'),
      fixed('src/workspace.ts'),
      ...(lsp ? [fixed('src/monaco-editor-worker.ts'), fixed('src/monaco-editor-core-worker.d.ts')] : []),
      fixed('src/posix-path-shim.ts'),
      { path: 'host-browser/test/smoke.spec.mts', content: hostSmokeSpec(composition) }
   ];
}

/** A JSON value as it sits at `indent` in a manifest npm writes. */
function jsonAt(value: unknown, indent: string): string {
   return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

/**
 * The languages and grammars a VS Code extension contributes. Each extension
 * declares its own, since either may be installed without the other; the
 * grammars are the server's, copied in by `copy:syntaxes`.
 */
function vscodeLanguageContributions(composition: InitComposition): Record<string, unknown> {
   return {
      grammars: composition.grammars.map(grammar => ({
         language: grammar.languageId,
         scopeName: `source.${grammar.languageId}`,
         path: `./syntaxes/${grammar.languageId}.tmLanguage.json`
      })),
      languages: composition.grammars.map(grammar => ({
         id: grammar.languageId,
         aliases: [grammar.grammar],
         extensions: grammar.extensions.map(extension => `.${extension}`)
      }))
   };
}

/** VS Code finds the grammars only inside the extension, so the build copies the server's. */
const COPY_SYNTAXES_SCRIPT = "require('node:fs').cpSync('../server/syntaxes', 'syntaxes', { recursive: true })";
const COPY_SYNTAXES = `node -e \\"${COPY_SYNTAXES_SCRIPT}\\"`;

/** `copy:syntaxes`, then again each time the server's `langium:watch` rewrites a grammar. */
const WATCH_SYNTAXES = `node -e \\"const copy = () => ${COPY_SYNTAXES_SCRIPT}; copy(); require('node:fs').watch('../server/syntaxes', copy)\\"`;

/**
 * The servers-only extension's `package.json`. Always private, like a host:
 * it is installed into an application, never as a dependency.
 *
 * `onStartupFinished` rather than `onLanguage`, since a Theia backend asks for
 * a port before any document is open.
 */
function vscodeServersPackageJson(composition: InitComposition): string {
   const dependencies: Record<string, string> = {
      [memberPackageName(composition, 'protocol')]: MEMBER_PIN,
      [memberPackageName(composition, 'server')]: MEMBER_PIN,
      ...VSCODE_LANGUAGE_CLIENT
   };
   if (socketHeads(composition).length > 0) {
      dependencies['@hydranium/client-vscode'] = frameworkPin(composition);
   }
   return `{
  "name": "${memberPackageName(composition, 'vscode-servers')}",
  "displayName": "${composition.name} Servers",
  "version": "0.0.0",
  "private": true,
  "description": "Starts the ${composition.name} server${socketHeads(composition).length > 0 ? " and publishes its socket heads' ports as host commands" : ''}, with no editor of its own.",
  "license": "UNLICENSED",
  "author": "",
  "publisher": "${composition.projectId}",
  "main": "./out/extension.js",
  "scripts": {
    "build": "npm run copy:syntaxes && tsc",
    "clean": "rimraf out syntaxes tsconfig.tsbuildinfo",
    "copy:syntaxes": "${COPY_SYNTAXES}",
${lintScript(forMember(composition, 'vscode-servers'), 'src')}    "watch": "concurrently --kill-others --names syntaxes,tsc \\"npm run watch:syntaxes\\" \\"tsc --watch\\"",
    "watch:syntaxes": "${WATCH_SYNTAXES}"
  },
  "dependencies": {
${sortedBlock(dependencies, '    ')}
  },
  "devDependencies": {
${sortedBlock({ '@types/node': '^22.0.0', '@types/vscode': VSCODE_ENGINE, concurrently: '^9.0.0', rimraf: '^5.0.0', typescript: '^7.0.2' }, '    ')}
  },
  "contributes": ${jsonAt(vscodeLanguageContributions(composition), '  ')},
  "activationEvents": [
    "onStartupFinished"
  ],
  "engines": {
    "vscode": "${VSCODE_ENGINE}"
  }
}
`;
}

/**
 * The servers-only extension's activation: the shared launch, and with a socket
 * head the port commands, which only this extension registers.
 */
function vscodeServersExtensionFile(composition: InitComposition): string {
   const upper = screamingSnake(composition.projectId);
   const heads = socketHeads(composition).map(head => head.key);
   const protocolSymbols = heads.flatMap(head => [`${upper}_${head}_HOST_COMMAND`, `${upper}_${head}_PORT_COMMAND`]);
   const imports =
      heads.length === 0
         ? ''
         : `import { registerPortCommands } from '@hydranium/client-vscode/node';
${importList(protocolSymbols, memberPackageName(composition, 'protocol'), columnsFor(composition))}
`;
   const portCommands =
      heads.length === 0
         ? ''
         : `

   // Each socket head's port as a host command, for a host with no language
   // client of its own. Not in the shared launch: VS Code throws on a second
   // registration of one id, so the VS Code extension beside this one would fail
   // to activate. A pass-through: awaiting anything else in it would hang a
   // Theia backend on a user dismissing a notification.
   registerPortCommands(context, client, {
${heads.map(head => `      [${upper}_${head}_HOST_COMMAND]: ${upper}_${head}_PORT_COMMAND`).join(',\n')}
   });`;
   return `// The servers-only extension: it starts the ${composition.name} server and contributes no
// editor, view or command. A Theia app sideloads this one rather than the VS
// Code extension, whose diagram editors would give its files a second editor.

${imports}import type { ExtensionContext } from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { start${composition.name}LanguageClient } from './language-client.js';

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
   client = await start${composition.name}LanguageClient(context);${portCommands}
}

export async function deactivate(): Promise<void> {
   await client?.stop();
   client = undefined;
}
`;
}

/**
 * The server launch both extensions share: one launch, so VS Code and a Theia
 * app sideloading the servers extension hand the server the same documents.
 */
function vscodeLanguageClientFile(composition: InitComposition): string {
   return `// Starts the ${composition.name} server for VS Code, and for a Theia app that sideloads
// this extension: one launch, so both hand the server the same documents.

import { ALL_LANGUAGES } from '${memberPackageName(composition, 'protocol')}';
import { type ExtensionContext, workspace } from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';

/** Fork the server, start its language client and return it once started. */
export async function start${composition.name}LanguageClient(context: ExtensionContext): Promise<LanguageClient> {
   // Resolved through the package, so it works from the workspace and from an
   // installed extension alike. Over IPC, which keeps the server's stdout free.
   const serverModule = require.resolve('${memberPackageName(composition, 'server')}/lib/main.js');
   const extensions = ALL_LANGUAGES.flatMap(language => language.fileExtensions).join(',');
   const client = new LanguageClient(
      '${composition.projectId}',
      '${composition.name}',
      { module: serverModule, transport: TransportKind.ipc },
      {
         documentSelector: ALL_LANGUAGES.map(({ languageId }) => ({ scheme: 'file', language: languageId })),
         // Changes on disk the editor does not hold, such as a file another tool writes.
         synchronize: { fileEvents: workspace.createFileSystemWatcher(\`**/*{\${extensions}}\`) }
      }
   );
   context.subscriptions.push(client);
   await client.start();

   return client;
}
`;
}

/** The folders of the Theia applications the composition emits, as code spans. */
function theiaApplicationPaths(composition: InitComposition): string[] {
   return composition.hosts.filter(isTheiaHost).map(host => `\`../host-${host}\``);
}

/** The servers-only extension's README. */
function vscodeServersReadme(composition: InitComposition): string {
   const vscode = composition.hosts.includes('vscode');
   const theiaApps = theiaApplicationPaths(composition);
   const intro = [
      'A VS Code extension that starts the __NAME__ server and contributes no editor, view or command: the languages, their grammars and the server.',
      `With a socket head, it also answers each head’s port under a host command, which a host without a language client of its own runs${
         theiaApps.length > 0
            ? theiaApps.length === 1
               ? `: the Theia application in ${theiaApps[0]}, which sideloads this extension.`
               : `: the Theia applications in ${listPhrase(theiaApps)}, which sideload this extension.`
            : ', such as a Theia app sideloading this extension.'
      }`,
      ...(vscode
         ? [
              'The VS Code extension in `../host-vscode` starts the server through the same function.',
              'Both work side by side, but each starts its own server and language client, so diagnostics may show twice: install one.'
           ]
         : [])
   ];
   const lines = [
      `# ${memberPackageName(composition, 'vscode-servers')}`,
      '',
      ...wrapProse(intro.join(' ')),
      '',
      '```bash',
      'npm run build   # copy the server’s grammars and compile into out/; build the server first',
      'npm run watch   # the same on every change',
      '```',
      '',
      '- `src/extension.ts` — activation, which starts the server and, with a socket head, registers its port commands',
      `- \`src/language-client.ts\` — the server launch${vscode ? ', shared with `../host-vscode`' : ''}`,
      ''
   ];
   return project(lines.join('\n'), composition);
}

/** The servers-only extension: the server's launch, without an editor. */
function vscodeServersFiles(composition: InitComposition): InitFile[] {
   return [
      { path: 'vscode-servers/package.json', content: vscodeServersPackageJson(composition) },
      ignoreFile('vscode-servers'),
      { path: 'vscode-servers/README.md', content: vscodeServersReadme(composition) },
      projectTemplate('vscode-servers/tsconfig.json', composition),
      { path: 'vscode-servers/src/extension.ts', content: vscodeServersExtensionFile(composition) },
      { path: 'vscode-servers/src/language-client.ts', content: vscodeLanguageClientFile(composition) }
   ];
}

/**
 * The custom-editor view type of a grammar's diagram, as the editor module
 * declares it. VS Code keys custom editors by view type alone, across every
 * installed extension, so it carries the language id, which `init` qualifies
 * by the project wherever the grammar is named apart from it.
 */
function diagramViewType(grammar: InitGrammarNames): string {
   return `${grammar.languageId}.diagram`;
}

/**
 * The VS Code extension's `package.json`. Always private, as every host is.
 *
 * A diagram file opens in its diagram by default; `Reopen Editor With` reaches
 * the text.
 */
function hostVscodePackageJson(composition: InitComposition): string {
   const diagrams = composition.grammars.filter(grammar => grammar.diagram);
   const dependencies: Record<string, string> = {
      [memberPackageName(composition, 'vscode-servers')]: MEMBER_PIN,
      ...VSCODE_LANGUAGE_CLIENT
   };
   if (diagrams.length > 0) {
      dependencies[memberPackageName(composition, 'client')] = MEMBER_PIN;
      dependencies[memberPackageName(composition, 'protocol')] = MEMBER_PIN;
      Object.assign(dependencies, HOST_VSCODE_GLSP_THIRD_PARTY_DEPENDENCIES);
      for (const framework of HOST_VSCODE_GLSP_FRAMEWORK_DEPENDENCIES) {
         dependencies[framework] = frameworkPin(composition);
      }
   }
   if (composition.heads.includes('data')) {
      dependencies[memberPackageName(composition, 'protocol')] = MEMBER_PIN;
      Object.assign(dependencies, HOST_VSCODE_DATA_THIRD_PARTY_DEPENDENCIES);
      for (const framework of HOST_VSCODE_DATA_FRAMEWORK_DEPENDENCIES) {
         dependencies[framework] = frameworkPin(composition);
      }
   }
   const devDependencies = { ...HOST_VSCODE_DEV_DEPENDENCIES, ...(diagrams.length > 0 ? { esbuild: '^0.28.0' } : {}) };
   const watches: Record<string, string> = {
      syntaxes: 'npm run watch:syntaxes',
      tsc: 'tsc --watch',
      ...(diagrams.length > 0 ? { webview: 'node esbuild.mjs --watch' } : {})
   };
   const watchNames = Object.keys(watches).join(',');
   const watchCommands = Object.values(watches)
      .map(command => `\\"${command}\\"`)
      .join(' ');
   const contributes = {
      ...(composition.heads.includes('data')
         ? { commands: [{ command: `${composition.projectId}.showModel`, title: 'Show Model', category: composition.name }] }
         : {}),
      ...(diagrams.length > 0
         ? {
              customEditors: diagrams.map(grammar => ({
                 viewType: diagramViewType(grammar),
                 displayName: `${grammar.grammar} Diagram`,
                 selector: grammar.extensions.map(extension => ({ filenamePattern: `*.${extension}` })),
                 priority: 'default'
              }))
           }
         : {}),
      ...vscodeLanguageContributions(composition)
   };
   const typecheck = [...(diagrams.length > 0 ? ['tsconfig.webview.json'] : []), 'tsconfig.e2e.json']
      .map(project => `tsc --noEmit -p ${project}`)
      .join(' && ');
   return `{
  "name": "${memberPackageName(composition, 'host-vscode')}",
  "displayName": "${composition.name}",
  "version": "0.0.0",
  "private": true,
  "description": "${composition.name} in VS Code: ${hostVscodeParts(composition)}.",
  "license": "UNLICENSED",
  "author": "",
  "publisher": "${composition.projectId}",
  "main": "./out/extension.js",
  "scripts": {
    "build": "npm run copy:syntaxes && npm run typecheck && tsc${diagrams.length > 0 ? ' && node esbuild.mjs' : ''}",
    "clean": "rimraf out syntaxes tsconfig.tsbuildinfo test-results playwright-report",
    "copy:syntaxes": "${COPY_SYNTAXES}",
${lintScript(forMember(composition, 'host-vscode'), 'src test')}    "start": "node start.mjs",
    "test:e2e": "playwright test --tsconfig tsconfig.e2e.json",
    "test:e2e:install": "node --experimental-strip-types test/install-vscode.mts",
    "typecheck": "${typecheck}",
    "watch": "concurrently --kill-others --names ${watchNames} ${watchCommands}",
    "watch:syntaxes": "${WATCH_SYNTAXES}"
  },
  "dependencies": {
${sortedBlock(dependencies, '    ')}
  },
  "devDependencies": {
${sortedBlock(devDependencies, '    ')}
  },
  "contributes": ${jsonAt(contributes, '  ')},
  "activationEvents": ${jsonAt(
     composition.grammars.map(grammar => `onLanguage:${grammar.languageId}`),
     '  '
  )},
  "engines": {
    "vscode": "${VSCODE_ENGINE}"
  }
}
`;
}

/** What the VS Code extension brings, as one phrase; `started` follows the language client. */
function hostVscodeParts(composition: InitComposition, started = ''): string {
   const parts = [
      `the language client${started}`,
      ...(composition.heads.includes('data') ? ['a Show Model command reading a file through the data head'] : []),
      ...(composition.grammars.some(grammar => grammar.diagram) ? ['a custom editor for each diagram'] : [])
   ];
   return listPhrase(parts);
}

/** `parts` as one English list: `a`, `a and b`, `a, b, and c`. */
function listPhrase(parts: readonly string[]): string {
   return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')}${parts.length > 2 ? ',' : ''} and ${parts.at(-1)}`;
}

/**
 * The VS Code extension's entry: the shared server launch, then the Show Model
 * command over the data head and a diagram editor per diagram grammar.
 */
function hostVscodeExtensionFile(composition: InitComposition): string {
   const columns = columnsFor(composition);
   const diagrams = composition.grammars.filter(grammar => grammar.diagram);
   const data = composition.heads.includes('data');
   const start = `start${composition.name}LanguageClient`;
   const servers = `${memberPackageName(composition, 'vscode-servers')}/out/language-client.js`;
   const upper = screamingSnake(composition.projectId);
   const editors = diagrams.map(grammar => ({
      module: `./${grammar.grammarId}-diagram-editor.js`,
      viewType: `${screamingSnake(grammar.grammarId)}_DIAGRAM_VIEW_TYPE`,
      provider: `${grammar.grammar}DiagramEditorProvider`,
      local: `${grammar.grammar.charAt(0).toLowerCase()}${grammar.grammar.slice(1)}Editor`
   }));
   const registrations = editors.map(
      editor => `   const ${editor.local} = new ${editor.provider}(glspConnector, context.extensionUri);
   context.subscriptions.push(
      window.registerCustomEditorProvider(${editor.viewType}, ${editor.local}, {
         // A hidden tab keeps its diagram session rather than repeating the handshake.
         webviewOptions: { retainContextWhenHidden: true },
         // Two views of one document would be two GLSP clients racing on one model.
         supportsMultipleEditorsPerDocument: false
      })
   );`
   );
   const sockets = data || diagrams.length > 0;
   const protocolSymbols = [
      ...(data ? [`${upper}_DATA_SERVER_PORT_COMMAND`] : []),
      ...(diagrams.length > 0 ? [`${upper}_GLSP_SERVER_PORT_COMMAND`] : []),
      ...(data ? [`type ${composition.name}Element`] : [])
   ];
   const imports = [
      ...(sockets ? ["import { findPort } from '@hydranium/client-vscode/node';"] : []),
      ...(data ? ["import { SocketDataPort } from '@hydranium/data-client-vscode/node';"] : []),
      ...(diagrams.length > 0
         ? ["import { HydraniumGlspVscodeConnector, HydraniumGlspVscodeServer } from '@hydranium/glsp-client-vscode/node';"]
         : []),
      ...(sockets
         ? [
              importList(
                 [
                    'ConsoleLogger',
                    ...(data ? ['DataConnectionWithEvents'] : []),
                    ...(diagrams.length > 0 ? ['describeError'] : []),
                    ...(data ? ['renderFrameworkMessage'] : [])
                 ],
                 '@hydranium/protocol',
                 columns
              )
           ]
         : []),
      ...(sockets ? [importList(protocolSymbols, memberPackageName(composition, 'protocol'), columns)] : []),
      ...(sockets
         ? [`import { ${[...(data ? ['commands'] : []), 'type ExtensionContext', 'window'].join(', ')} } from 'vscode';`]
         : ["import type { ExtensionContext } from 'vscode';"]),
      "import type { LanguageClient } from 'vscode-languageclient/node';",
      `import { ${start} } from '${servers}';`,
      ...editors.map(editor => importList([editor.viewType, editor.provider], editor.module, columns)),
      ...(data ? ["import { showModelCommand } from './show-model-command.js';"] : [])
   ];
   const dataBlock = data
      ? `

   // The data head, read by the Show Model command. Nothing connects until it runs.
   const dataPort = new SocketDataPort({
      findPort: () => findPort(running, ${upper}_DATA_SERVER_PORT_COMMAND),
      logger: new ConsoleLogger().with('data head'),
      // A failed read shown to the user, not only logged; the message carries the detail.
      reportError: (_error, reported) => void window.showErrorMessage(renderFrameworkMessage(reported))
   });
   const dataConnection = new DataConnectionWithEvents<${composition.name}Element>(dataPort);
   context.subscriptions.push(dataConnection, dataPort, commands.registerCommand('${composition.projectId}.showModel', showModelCommand(dataConnection)));`
      : '';
   const glspBlock =
      diagrams.length > 0
         ? `

   // The GLSP head, and the connector bridging it to every diagram webview. No
   // \`messenger\` option: the connector's own keeps messages flowing to a hidden tab.
   const glspServer = new HydraniumGlspVscodeServer({
      clientId: '${composition.projectId}-glsp',
      clientName: '${composition.name}',
      findPort: () => findPort(running, ${upper}_GLSP_SERVER_PORT_COMMAND),
      logger: new ConsoleLogger().with('GLSP head')
   });
   const glspConnector = new HydraniumGlspVscodeConnector({ server: glspServer, logging: false });
   context.subscriptions.push(glspServer, glspConnector);
   // Not awaited, so a session that opens no diagram does not wait on the port.
   // \`start()\` resolves either way; a failure is reported off \`onReady\`.
   void glspServer.start();
   void glspServer.onReady.catch((error: unknown) => {
      void window.showErrorMessage(\`${composition.name} diagram unavailable: \${describeError(error)}\`);
   });
${registrations.join('\n')}`
         : '';
   const opening = wrapComment(
      `The ${composition.name} VS Code extension: ${hostVscodeParts(composition, ', started the way the servers extension starts it')}.${sockets ? ' Node extension host only: the server is forked and its socket heads reached over TCP.' : ''}`
   );
   const activation = sockets
      ? `   const running = await ${start}(context);
   client = running;${dataBlock}${glspBlock}`
      : `   client = await ${start}(context);`;
   return `${opening}

${imports.join('\n')}

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
${activation}
}

export async function deactivate(): Promise<void> {
   await client?.stop();
   client = undefined;
}
`;
}

/** A smoke test's title: what it checks of each head the composition has. */
function hostVscodeSmokeTitle(composition: InitComposition): string {
   return listPhrase([
      ...(composition.heads.includes('data') ? ['reads the model'] : []),
      ...(composition.grammars.some(grammar => grammar.diagram) ? ['draws the diagram'] : []),
      'reports a broken reference'
   ]);
}

/**
 * The smoke test: VS Code opens the starter workspace with the extension
 * loaded, Show Model names the model with the data head, each diagram file
 * draws, and the server reports a broken reference.
 */
function hostVscodeSmokeSpec(composition: InitComposition): string {
   const diagram = composition.grammars.find(grammar => grammar.diagram);
   const file = `nodes.${(diagram ?? composition.grammars[0]).extensions[0]}`;
   const diagramSteps = diagram
      ? `
      // The diagram file opens in its diagram, which draws the two starter nodes.
      const webview = page.frameLocator('iframe.webview.ready').frameLocator('#active-frame');
      // In the editor's container: sprotty measures shapes in a hidden copy beside it.
      await expect(webview.locator('.hydranium-diagram-container .sprotty-node')).toHaveCount(2);
      // Then as text. The row is clicked, since Enter runs the best fuzzy match,
      // and its name ends in its keybinding, if it has one.
      await page.keyboard.press('ControlOrMeta+Shift+P');
      await page.locator('.quick-input-widget input').fill('>View: Reopen Editor with Text Editor');
      await page
         .locator('.quick-input-list')
         .getByRole('option', { name: /^View: Reopen Editor with Text Editor(,|$)/ })
         .click();
`
      : '';
   const primary = diagram ?? composition.grammars[0];
   const showModelSteps = composition.heads.includes('data')
      ? `      // The data head reads the open file.
      await page.keyboard.press('ControlOrMeta+Shift+P');
      await page.locator('.quick-input-widget input').fill('>${composition.name}: Show Model');
      await page
         .locator('.quick-input-list')
         .getByRole('option', { name: /^${composition.name}: Show Model(,|$)/ })
         .click();
      await expect(page.locator('.notification-toast').filter({ hasText: '${file} holds a ${primary.entryRule}' })).toBeVisible();
`
      : '';
   const opening = wrapComment(
      `VS Code opens a copy of the starter workspace with this extension loaded, ${listPhrase([
         ...(composition.heads.includes('data') ? ['the data head reads the file'] : []),
         ...(diagram ? ['the diagram file draws in its diagram editor'] : []),
         'the server reports a reference that resolves to nothing'
      ])}.`
   );
   return `${opening}

import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VSCODE_CACHE, VSCODE_VERSION } from './vscode-version.mts';

const extensionRoot = fileURLToPath(new URL('..', import.meta.url));

test('${hostVscodeSmokeTitle(composition)}', async () => {
   // A copy, since the server writes its repairs to the folder it opens, and a
   // fresh profile, since a reused one restores the last run's editors.
   const scratch = mkdtempSync(join(tmpdir(), '${composition.projectId}-vscode-'));
   const workspace = join(scratch, 'workspace');
   cpSync(fileURLToPath(new URL('../../workspace', import.meta.url)), workspace, { recursive: true });
   let app: ElectronApplication | undefined;
   try {
      app = await _electron.launch({
         executablePath: await downloadAndUnzipVSCode({ version: VSCODE_VERSION, cachePath: VSCODE_CACHE }),
         args: [
            '--no-sandbox',
            '--disable-gpu-sandbox',
            '--disable-updates',
            '--skip-welcome',
            '--skip-release-notes',
            '--disable-workspace-trust',
            '--disable-extensions',
            \`--extensionDevelopmentPath=\${extensionRoot}\`,
            \`--user-data-dir=\${join(scratch, 'user-data')}\`,
            \`--extensions-dir=\${join(scratch, 'extensions')}\`,
            workspace
         ]
      });
      const page = await app.firstWindow();
      await expect(page.locator('.monaco-workbench')).toBeVisible();
      await quickOpen(page, '${file}');
${showModelSteps}${diagramSteps}
      const editor = page.locator('.monaco-editor .view-lines').first();
      await expect(editor).toContainText('node First');
      await editor.click();
      await page.keyboard.press('ControlOrMeta+End');
      // In one edit: typed key by key, the half-typed reference is reported on the way.
      await page.keyboard.insertText('\\nnode Broken -> Missing');
      await expect(page.locator('.monaco-editor .squiggly-error').first()).toBeVisible();
   } finally {
      await app?.close();
      rmSync(scratch, { recursive: true, force: true });
   }
});

/** Open \`file\` through Quick Open, so it gets the editor a user would. */
async function quickOpen(page: Page, file: string): Promise<void> {
   await page.keyboard.press('ControlOrMeta+P');
   const input = page.locator('.quick-input-widget input');
   await input.fill(file);
   await expect(page.locator('.quick-input-list .monaco-list-row').first()).toContainText(file);
   await input.press('Enter');
   await expect(page.locator('.quick-input-widget')).toBeHidden();
}
`;
}

/**
 * `text` broken at spaces into lines of at most 80 columns, the width
 * `check:docs` holds Markdown to. A link or code span stays whole, and runs
 * long on a line of its own.
 */
function wrapProse(text: string, width = 80): string[] {
   const lines: string[] = [];
   for (const piece of text.match(/!?\[[^\]]*\]\([^)]*\)\S*|`+[^`]*`+\S*|\S+/g) ?? []) {
      const last = lines.at(-1);
      if (last !== undefined && last.length + 1 + piece.length <= width) {
         lines[lines.length - 1] = `${last} ${piece}`;
      } else {
         lines.push(piece);
      }
   }
   return lines;
}

/** `text` as a `//` comment of lines at most 80 columns wide. */
function wrapComment(text: string): string {
   return wrapProse(text, 77)
      .map(line => `// ${line}`)
      .join('\n');
}

/** The VS Code extension's README. */
function hostVscodeReadme(composition: InitComposition): string {
   const diagrams = composition.grammars.filter(grammar => grammar.diagram);
   const data = composition.heads.includes('data');
   const intro = [
      diagrams.length > 0
         ? `${composition.name} in VS Code: the language client, and a custom editor drawing each diagram file.`
         : `${composition.name} in VS Code: the language client.`,
      'The server is started by `../vscode-servers`, whose launch this extension calls, so the two never hand the server different documents.',
      socketHeads(composition).length > 0
         ? 'It needs a Node extension host: the server is forked, and its socket heads are reached over TCP.'
         : 'It needs a Node extension host, since the server is forked.'
   ];
   const dataNote = `\`${composition.name}: Show Model\`, in the Command Palette, reads the active file through the data head over a socket from the extension host, and names its root type. A webview reaches the data head too: see the Host in VS Code guide.`;
   const lines = [
      `# ${memberPackageName(composition, 'host-vscode')}`,
      '',
      ...wrapProse(intro.join(' ')),
      ...(data ? ['', ...wrapProse(dataNote)] : []),
      '',
      '```bash',
      `npm run build              # copy the server’s grammars, type-check and compile${diagrams.length > 0 ? ', then bundle' : ''}`,
      `npm run watch              # copy the grammars and recompile${diagrams.length > 0 ? ' and rebundle' : ''} on every change; Developer: Reload Window picks it up`,
      'npm start                  # VS Code with this extension, on ../workspace; needs `code` on the PATH',
      'npm run test:e2e:install   # download the VS Code the smoke test drives, once',
      'npm run test:e2e           # the smoke test; under `xvfb-run -a` on Linux without a display',
      '```',
      '',
      '## Layout',
      '',
      `- \`src/extension.ts\` — activation: ${listPhrase([
         'the server, through `../vscode-servers`',
         ...(data ? ['the Show Model command'] : []),
         ...(diagrams.length > 0 ? ['the diagram editors'] : [])
      ])}`,
      ...(data ? ['- `src/show-model-command.ts` — Show Model: the active file, read through the data head'] : []),
      ...diagrams.flatMap(grammar => [
         `- \`src/${grammar.grammarId}-diagram-editor.ts\` — the \`${grammar.grammar}\` diagram’s custom editor; its view type is the one \`package.json\` declares`,
         `- \`src/webview/${grammar.grammarId}-diagram.ts\` — the webview it loads, over the client package’s diagram`
      ]),
      ...(diagrams.length > 0
         ? ['- `src/webview/diagram.css` — the webview’s size and colours', '- `esbuild.mjs` — bundles each webview into `out/webview/`']
         : []),
      '- `start.mjs` — `npm start`: VS Code with this extension, on `../workspace`',
      '- `test/smoke.spec.mts` — VS Code opens the workspace, ' +
         (composition.heads.includes('data') ? 'Show Model names the model, ' : '') +
         (diagrams.length > 0 ? 'the diagram draws, ' : '') +
         'and the server reports a broken reference',
      '- `test/vscode-version.mts` — the VS Code release the smoke test runs',
      ''
   ];
   return project(lines.join('\n'), composition);
}

/** The VS Code extension: the language client and a diagram editor per diagram grammar. */
function hostVscodeFiles(composition: InitComposition): InitFile[] {
   const fixed = (file: string): InitFile => projectTemplate(`host-vscode/${file}`, composition);
   const diagrams = composition.grammars.filter(grammar => grammar.diagram);
   return [
      { path: 'host-vscode/package.json', content: hostVscodePackageJson(composition) },
      ignoreFile('host-vscode'),
      { path: 'host-vscode/README.md', content: hostVscodeReadme(composition) },
      fixed('tsconfig.json'),
      fixed('tsconfig.e2e.json'),
      fixed('playwright.config.mts'),
      fixed('start.mjs'),
      { path: 'host-vscode/src/extension.ts', content: hostVscodeExtensionFile(composition) },
      ...(composition.heads.includes('data') ? [fixed('src/show-model-command.ts')] : []),
      ...(diagrams.length > 0 ? [fixed('tsconfig.webview.json'), fixed('esbuild.mjs'), fixed('src/webview/diagram.css')] : []),
      ...diagrams.flatMap(grammar => [
         grammarTemplate('host-vscode/src/__GRAMMAR_ID__-diagram-editor.ts', composition, grammar),
         grammarTemplate('host-vscode/src/webview/__GRAMMAR_ID__-diagram.ts', composition, grammar)
      ]),
      { path: 'host-vscode/test/smoke.spec.mts', content: hostVscodeSmokeSpec(composition) },
      fixed('test/vscode-version.mts'),
      fixed('test/install-vscode.mts')
   ];
}

/**
 * The Theia release of every Theia member, the one the framework's own
 * Theia examples take, so a scaffold builds against what the repo tests: the
 * Theia community release. Exact, as Theia's members pin each other, so a
 * workspace root declares it too and GLSP's open Theia peer resolves to it.
 */
const THEIA_VERSION = '1.74.3';

/**
 * What each head adds to the Theia extension; `base` is the connection hardening
 * and editor sync every one gets. With the third-party entries below, they name
 * the peers of the framework's Theia packages, so an installer that adds no peers
 * still finds them.
 */
const THEIA_FRAMEWORK_DEPENDENCIES: Record<InitHead | 'base', readonly string[]> = {
   base: ['@hydranium/client-theia', '@hydranium/protocol'],
   lsp: [],
   data: ['@hydranium/data-client-theia'],
   glsp: ['@hydranium/glsp-client', '@hydranium/glsp-client-theia']
};
const THEIA_THIRD_PARTY_DEPENDENCIES: Record<InitHead | 'base', Readonly<Record<string, string>>> = {
   base: {
      '@theia/core': THEIA_VERSION,
      '@theia/editor': THEIA_VERSION,
      '@theia/filesystem': THEIA_VERSION,
      '@theia/output': THEIA_VERSION,
      inversify: '^6.1.3',
      'vscode-jsonrpc': '9.0.3'
   },
   lsp: {},
   data: { '@theia/workspace': THEIA_VERSION },
   glsp: {
      '@eclipse-glsp/client': '2.8.0',
      '@eclipse-glsp/theia-integration': '2.8.0',
      '@theia/process': THEIA_VERSION,
      '@theia/workspace': THEIA_VERSION
   }
};

/** The Theia extension's third-party pins for `heads`, for its manifest and a workspace root's. */
function theiaThirdPartyDependencies(heads: readonly InitHead[]): Array<[string, string]> {
   return (['base', ...heads] as const).flatMap(head => Object.entries(THEIA_THIRD_PARTY_DEPENDENCIES[head]));
}

/**
 * The Theia packages the application assembles: the workbench a user expects,
 * and `plugin-ext` with its VS Code API to sideload the servers extension.
 */
const HOST_THEIA_BROWSER_DEPENDENCIES: readonly string[] = [
   '@theia/core',
   '@theia/editor',
   '@theia/filesystem',
   '@theia/markers',
   '@theia/messages',
   '@theia/monaco',
   '@theia/navigator',
   '@theia/output',
   '@theia/plugin-ext',
   '@theia/plugin-ext-vscode',
   '@theia/preferences',
   '@theia/process',
   '@theia/workspace'
];

/** The Theia tooling the application builds with. */
const HOST_THEIA_BROWSER_DEV_DEPENDENCIES: readonly string[] = ['@theia/cli'];

/** Every Theia package the application declares, for a workspace root's pins. */
function hostTheiaBrowserTheiaDependencies(): Array<[string, string]> {
   return [...HOST_THEIA_BROWSER_DEPENDENCIES, ...HOST_THEIA_BROWSER_DEV_DEPENDENCIES].map(name => [name, THEIA_VERSION]);
}

/** The Electron application's Theia packages: the browser application's, and Theia's Electron integration. */
const HOST_THEIA_ELECTRON_DEPENDENCIES: readonly string[] = [...HOST_THEIA_BROWSER_DEPENDENCIES, '@theia/electron'].sort();

/** The Electron release `@theia/electron` peers on, exactly. */
const ELECTRON_VERSION = '42.11.16';

/** Every package the Electron application pins, for a workspace root's pins. */
function hostTheiaElectronPins(): Array<[string, string]> {
   return [
      ...[...HOST_THEIA_ELECTRON_DEPENDENCIES, ...HOST_THEIA_BROWSER_DEV_DEPENDENCIES].map((name): [string, string] => [
         name,
         THEIA_VERSION
      ]),
      ['electron', ELECTRON_VERSION]
   ];
}

/** The Theia extension's `theiaExtensions` entries: one per head it forwards, and one per diagram. */
function theiaExtensionEntries(composition: InitComposition): Array<Record<string, string>> {
   const id = composition.projectId;
   return [
      {
         frontendPreload: `lib/browser/${id}-connection-preload-module`,
         frontend: `lib/browser/${id}-frontend-module`,
         backend: `lib/node/${id}-connection-backend-module`
      },
      ...(composition.heads.includes('data') ? [{ backend: `lib/node/${id}-data-backend-module` }] : []),
      ...(composition.heads.includes('glsp') ? [{ backend: `lib/node/${id}-glsp-backend-module` }] : []),
      ...composition.grammars
         .filter(grammar => grammar.diagram)
         .map(grammar => ({ frontend: `lib/browser/${grammar.grammarId}-diagram-frontend-module` }))
   ];
}

/** The Theia extension's `package.json`. Private unless `--public`, as the client member is. */
function theiaPackageJson(composition: InitComposition): string {
   const dependencies: Record<string, string> = {
      // The socket heads' host commands, and the data head's model type.
      ...(socketHeads(composition).length > 0 ? { [memberPackageName(composition, 'protocol')]: MEMBER_PIN } : {}),
      ...(composition.heads.includes('glsp') ? { [memberPackageName(composition, 'client')]: MEMBER_PIN } : {}),
      ...Object.fromEntries(theiaThirdPartyDependencies(composition.heads))
   };
   for (const head of ['base', ...composition.heads] as const) {
      for (const framework of THEIA_FRAMEWORK_DEPENDENCIES[head]) {
         dependencies[framework] = frameworkPin(composition);
      }
   }
   return `{
  "name": "${memberPackageName(composition, 'theia')}",
  "version": "0.0.0",
${composition.packaging.private ? '  "private": true,\n' : ''}  "description": "The ${composition.name} Theia extension: ${theiaParts(composition)}.",
  "license": "UNLICENSED",
  "author": "",
  "files": [
    "lib",
    "src",
    "style"
  ],
  "scripts": {
    "build": "tsc",
    "clean": "rimraf lib tsconfig.tsbuildinfo",
${lintScript(forMember(composition, 'theia'), 'src')}    "watch": "tsc --watch"
  },
  "dependencies": {
${sortedBlock(dependencies, '    ')}
  },
  "devDependencies": {
${sortedBlock({ '@types/node': '^22.0.0', rimraf: '^5.0.0', typescript: '^7.0.2' }, '    ')}
  },
  "engines": {
    "node": ">=22.13"
  },
  "theiaExtensions": ${jsonAt(theiaExtensionEntries(composition), '  ')}
}
`;
}

/** What the Theia extension brings, as one phrase. */
function theiaParts(composition: InitComposition): string {
   return listPhrase([
      'reconnect hardening',
      ...(composition.heads.includes('data') ? ['a Show Model command reading a file through the data head'] : []),
      ...(composition.grammars.some(grammar => grammar.diagram) ? ['a diagram editor for each diagram'] : [])
   ]);
}

/** The extension's one frontend module: the logger, the connection diagnostics and editor sync, and each head's client. */
function theiaFrontendModuleFile(composition: InitComposition): string {
   const id = composition.projectId;
   const name = composition.name;
   const data = composition.heads.includes('data');
   const glsp = composition.heads.includes('glsp');
   const imports = [
      ...(glsp ? ["import { GLSPClientContribution } from '@eclipse-glsp/theia-integration';"] : []),
      "import { bindChannelLogger, bindConnectionDiagnostics, bindEditorDiskSync } from '@hydranium/client-theia/browser';",
      ...(data
         ? [
              "import { bindDataConnection } from '@hydranium/data-client-theia/browser';",
              "import { CommandContribution } from '@theia/core';"
           ]
         : []),
      "import { ContainerModule } from '@theia/core/shared/inversify';",
      ...(data
         ? [
              `import { ${name}DataConnection } from './${id}-data-connection.js';`,
              `import { ${name}DataPort } from './${id}-data-port.js';`
           ]
         : []),
      ...(glsp ? [`import { ${name}GlspClientContribution } from './${id}-glsp-client-contribution.js';`] : []),
      ...(data ? [`import { ${name}ShowModelCommand } from './${id}-show-model-command.js';`] : [])
   ];
   const dataBlock = data
      ? `

   // The data head: one connection, opened when the command first runs.
   bind(${name}DataPort).toSelf().inSingletonScope();
   bindDataConnection(bind, isBound, ${name}DataConnection);
   bind(${name}ShowModelCommand).toSelf().inSingletonScope();
   bind(CommandContribution).toService(${name}ShowModelCommand);`
      : '';
   const glspBlock = glsp
      ? `

   // One GLSP client for every diagram, so each diagram module skips binding its own.
   bind(${name}GlspClientContribution).toSelf().inSingletonScope();
   bind(GLSPClientContribution).toService(${name}GlspClientContribution);`
      : '';
   return `${wrapComment(
      `The ${name} Theia extension's frontend: ${listPhrase([
         'the connection’s lifecycle in an Output channel',
         'a warning when an outage outlasts the offline buffer',
         'editor disk sync',
         ...(data ? ['the data head’s connection and the Show Model command'] : []),
         ...(glsp ? ['the GLSP client the diagrams share'] : [])
      ])}.`
   )}

${imports.join('\n')}

export default new ContainerModule((bind, _unbind, isBound, rebind) => {
   bindChannelLogger(bind, { channelName: '${name} Connection' });
   bindConnectionDiagnostics(bind);
   // Keeps an editor from writing over a file a head saved while it held the same text unsaved.
   bindEditorDiskSync(bind, isBound, rebind);${dataBlock}${glspBlock}
});
`;
}

/** The Theia extension's README. */
function theiaReadme(composition: InitComposition): string {
   const id = composition.projectId;
   const data = composition.heads.includes('data');
   const glsp = composition.heads.includes('glsp');
   const diagrams = composition.grammars.filter(grammar => grammar.diagram);
   const theiaApps = theiaApplicationPaths(composition);
   const intro = [
      `The ${composition.name} Theia extension: ${theiaParts(composition)}.`,
      socketHeads(composition).length > 0
         ? 'The language client is not here: the application sideloads `../vscode-servers`, which starts the server and answers each socket head’s port under a host command, and the backend modules forward the page’s channels to those ports.'
         : 'The language client is not here: the application sideloads `../vscode-servers`, which starts the server.',
      theiaApps.length === 1 ? `The application in ${theiaApps[0]} runs it.` : `The applications in ${listPhrase(theiaApps)} run it.`
   ];
   const before = [...(socketHeads(composition).length > 0 ? ['protocol'] : []), ...(glsp ? ['client'] : [])];
   const lines = [
      `# ${memberPackageName(composition, 'theia')}`,
      '',
      ...wrapProse(intro.join(' ')),
      '',
      '```bash',
      'npm run build   # compile into lib/' +
         (before.length > 0 ? `; build the ${before.join(' and ')} package${before.length > 1 ? 's' : ''} first` : ''),
      '```',
      '',
      '## Layout',
      '',
      `- \`src/browser/${id}-connection-preload-module.ts\` and \`src/node/${id}-connection-backend-module.ts\` — reconnect hardening, sized by the application’s \`connectionBufferBytes\``,
      `- \`src/browser/${id}-frontend-module.ts\` — the frontend bindings`,
      ...(data
         ? [
              `- \`src/browser/${id}-data-port.ts\` and \`${id}-data-connection.ts\` — the data head’s connection`,
              `- \`src/browser/${id}-show-model-command.ts\` — \`${composition.name}: Show Model\`, reading the current file through the data head`,
              `- \`src/node/${id}-data-backend-module.ts\` — forwards the data channel to the data head’s port`
           ]
         : []),
      ...(glsp
         ? [
              `- \`src/common/${id}-glsp-contribution.ts\` — the id the GLSP client and its forwarder share`,
              `- \`src/browser/${id}-glsp-client-contribution.ts\` — the GLSP client every diagram shares`,
              `- \`src/node/${id}-glsp-backend-module.ts\` — forwards the GLSP channel to the GLSP head’s port`
           ]
         : []),
      ...diagrams.map(
         grammar =>
            `- \`src/browser/${grammar.grammarId}-diagram-frontend-module.ts\` — the \`${grammar.grammar}\` diagram editor, over the client package’s diagram`
      ),
      ...(diagrams.length > 0 ? ['- `style/diagram.css` — the diagrams’ colours, from the Theia theme'] : []),
      ''
   ];
   return project(lines.join('\n'), composition);
}

/** The Theia extension: what a Theia application runs of the language, beside the sideloaded servers extension. */
function theiaFiles(composition: InitComposition): InitFile[] {
   const fixed = (file: string): InitFile => ({
      path: project(`theia/${file}`, composition),
      content: project(template(`theia/${file}`), composition)
   });
   const id = composition.projectId;
   const data = composition.heads.includes('data');
   const glsp = composition.heads.includes('glsp');
   const diagrams = composition.grammars.filter(grammar => grammar.diagram);
   return [
      { path: 'theia/package.json', content: theiaPackageJson(composition) },
      ignoreFile('theia'),
      { path: 'theia/README.md', content: theiaReadme(composition) },
      fixed('tsconfig.json'),
      fixed('src/browser/__PROJECT_ID__-connection-preload-module.ts'),
      { path: `theia/src/browser/${id}-frontend-module.ts`, content: theiaFrontendModuleFile(composition) },
      fixed('src/node/__PROJECT_ID__-connection-backend-module.ts'),
      ...(data
         ? [
              fixed('src/browser/__PROJECT_ID__-data-port.ts'),
              fixed('src/browser/__PROJECT_ID__-data-connection.ts'),
              fixed('src/browser/__PROJECT_ID__-show-model-command.ts'),
              fixed('src/node/__PROJECT_ID__-data-backend-module.ts')
           ]
         : []),
      ...(glsp
         ? [
              fixed('src/common/__PROJECT_ID__-glsp-contribution.ts'),
              fixed('src/browser/__PROJECT_ID__-glsp-client-contribution.ts'),
              fixed('src/node/__PROJECT_ID__-glsp-backend-module.ts')
           ]
         : []),
      ...diagrams.map(grammar => grammarTemplate('theia/src/browser/__GRAMMAR_ID__-diagram-frontend-module.ts', composition, grammar)),
      ...(diagrams.length > 0 ? [fixed('style/diagram.css')] : [])
   ];
}

/**
 * The Theia application's `package.json`. Always private, as every host is.
 *
 * Theia's default `frontendConnectionTimeout` of 0 ends the session on any
 * dropped socket, and the page reloads; a minute lets the reconnect hardening
 * resume it.
 */
function hostTheiaBrowserPackageJson(composition: InitComposition): string {
   const dependencies: Record<string, string> = {
      [memberPackageName(composition, 'theia')]: MEMBER_PIN,
      ...Object.fromEntries(HOST_THEIA_BROWSER_DEPENDENCIES.map(name => [name, THEIA_VERSION]))
   };
   const devDependencies: Record<string, string> = {
      // Built before this application, whose start links it into plugins/.
      [memberPackageName(composition, 'vscode-servers')]: MEMBER_PIN,
      '@playwright/test': '^1.55.0',
      ...Object.fromEntries(HOST_THEIA_BROWSER_DEV_DEPENDENCIES.map(name => [name, THEIA_VERSION])),
      '@types/node': '^22.0.0',
      rimraf: '^5.0.0',
      typescript: '^7.0.2'
   };
   const theia = {
      target: 'browser',
      frontend: {
         config: {
            applicationName: composition.name,
            connectionBufferBytes: 102400,
            preferences: { 'security.workspace.trust.enabled': false }
         }
      },
      backend: { config: { connectionBufferBytes: 102400, frontendConnectionTimeout: 60000 } }
   };
   return `{
  "name": "${memberPackageName(composition, 'host-theia-browser')}",
  "version": "0.0.0",
  "private": true,
  "description": "${composition.name} in a Theia browser application: the Theia extension, and the servers extension sideloaded for the language client.",
  "license": "UNLICENSED",
  "author": "",
  "scripts": {
    "build": "theia build --mode development && npm run typecheck",
    "clean": "rimraf lib src-gen plugins gen-esbuild.browser.mjs gen-esbuild.node.mjs smoke-workspace test-results playwright-report",
${lintScript(forMember(composition, 'host-theia-browser'), 'test')}    "start": "node start.mjs",
    "test:e2e": "playwright test --tsconfig tsconfig.e2e.json",
    "test:e2e:install": "playwright install chromium",
    "typecheck": "tsc --noEmit -p tsconfig.e2e.json",
    "watch": "theia build --watch --mode development"
  },
  "dependencies": {
${sortedBlock(dependencies, '    ')}
  },
  "devDependencies": {
${sortedBlock(devDependencies, '    ')}
  },
  "engines": {
    "node": ">=22.13"
  },
  "theia": ${jsonAt(theia, '  ')}
}
`;
}

/**
 * The Theia smoke test: the application opens a copy of the starter
 * workspace, and each head answers. The steps are the same in both
 * applications; the browser one's page is Chromium on the server the
 * configuration starts, the Electron one's the window the test launches.
 */
function theiaSmokeSpec(composition: InitComposition, target: 'browser' | 'electron'): string {
   const data = composition.heads.includes('data');
   const diagram = composition.grammars.find(grammar => grammar.diagram);
   const primary = diagram ?? composition.grammars[0];
   const file = `nodes.${primary.extensions[0]}`;
   const showModelSteps = data
      ? `
   // The data head reads the open file, with focus in the Explorer beside it.
   await page.locator('.theia-FileTree .theia-TreeNode', { hasText: '${file}' }).click();
   await expect(page.locator('.theia-FileTree:focus-within')).toHaveCount(1);
   await runCommand(page, '${composition.name}: Show Model');
   // \`first()\`: Theia lists a notification in its toast and in the notification centre.
   await expect(
      page.locator('.theia-notification-message').filter({ hasText: '${file} holds a ${primary.entryRule}' }).first()
   ).toBeVisible();
`
      : '';
   const diagramSteps = diagram
      ? `
   // The diagram file opens in its diagram, which draws the two starter nodes.
   // In the editor's copy: sprotty measures shapes in a hidden one on the page.
   await expect(page.locator('.sprotty:not(.sprotty-hidden) .sprotty-node')).toHaveCount(2);
`
      : '';
   const textSteps = diagram
      ? `   // Then as text, through the Explorer's Open With.
   await page.locator('.theia-FileTree .theia-TreeNode', { hasText: '${file}' }).click({ button: 'right' });
   await page.locator('.lm-Menu-item', { hasText: 'Open With...' }).click();
   await page.locator('.quick-input-list .monaco-list-row', { hasText: 'Text Editor' }).click();
`
      : '';
   return `${wrapComment(
      `Theia opens a copy of the starter workspace with this application's extensions, ${listPhrase([
         ...(diagram ? ['the diagram file draws in its diagram editor'] : []),
         ...(data ? ['the data head reads the file'] : []),
         'the server reports a reference that resolves to nothing'
      ])}.`
   )}

${target === 'browser' ? "import { expect, test, type Page } from '@playwright/test';\n" : theiaElectronSmokeFixture(composition)}
test('${listPhrase([...(diagram ? ['draws the diagram'] : []), ...(data ? ['reads the model'] : []), 'reports a broken reference'])}', async ({ page }) => {
${target === 'browser' ? "   await page.goto('/');\n" : ''}   // Up once the loading screen is gone; a key pressed before then is lost.
   await expect(page.locator('.theia-preload')).toHaveCount(0);
   await page.keyboard.press('ControlOrMeta+Shift+E');
   await expect(page.locator('.theia-FileTree .theia-TreeNode', { hasText: '${file}' })).toBeVisible();
   await quickOpen(page, '${file}');
${diagramSteps}${showModelSteps}
${textSteps}   const editor = page.locator('.monaco-editor .view-lines').first();
   await expect(editor).toContainText('node First');
   await editor.click();
   await page.keyboard.press('ControlOrMeta+End');
   // In one edit: typed key by key, the half-typed reference is reported on the way.
   await page.keyboard.insertText('\\nnode Broken -> Missing');
   await expect(page.locator('.monaco-editor .squiggly-error').first()).toBeVisible();
});

/** Open \`file\` through Quick Open, so it gets the editor a user would. */
async function quickOpen(page: Page, file: string): Promise<void> {
   await page.keyboard.press('ControlOrMeta+P');
   const input = page.locator('.quick-input-widget input');
   await input.fill(file);
   await expect(page.locator('.quick-input-list .monaco-list-row').first()).toContainText(file);
   await input.press('Enter');
   await expect(page.locator('.quick-input-widget')).toBeHidden();
}
${
   data
      ? `
/** Run the command whose palette entry reads \`label\`, checked before Enter, since the match is fuzzy. */
async function runCommand(page: Page, label: string): Promise<void> {
   await page.keyboard.press('F1');
   const input = page.locator('.quick-input-widget input');
   await input.fill(\`>\${label}\`);
   await expect(page.locator('.quick-input-list .monaco-list-row.focused')).toContainText(label);
   await input.press('Enter');
   await expect(page.locator('.quick-input-widget')).toBeHidden();
}
`
      : ''
}`;
}

/** The Theia application's README. */
function hostTheiaBrowserReadme(composition: InitComposition): string {
   const intro = [
      `${composition.name} in a Theia browser application: the Theia extension in \`../theia\`, and \`../vscode-servers\` sideloaded through \`@theia/plugin-ext\`, which starts the server and its language client.`,
      'The backend runs the server, so this is a Node application; Theia serves the page.',
      ...(composition.grammars.some(grammar => grammar.diagram)
         ? ['The servers extension contributes no editor, so a diagram file opens in the Theia diagram editor alone.']
         : [])
   ];
   const lines = [
      `# ${memberPackageName(composition, 'host-theia-browser')}`,
      '',
      ...wrapProse(intro.join(' ')),
      '',
      '```bash',
      'npm run build              # bundle and type-check; build the members first',
      'npm run watch              # rebundle whenever the members’ builds change; reload the page to pick it up',
      'npm start                  # Theia at http://localhost:3000 on ../workspace; THEIA_PORT picks another port',
      'npm run test:e2e:install   # download the Chromium the smoke test drives, once',
      'npm run test:e2e           # the smoke test, which starts the application itself',
      '```',
      '',
      ...wrapProse(
         'The `theia` block of `package.json` sets `frontendConnectionTimeout`, without which Theia ends the session on any dropped socket and the page reloads, and `connectionBufferBytes`, the messages kept while the socket is down; the Theia extension’s connection modules read both.'
      ),
      '',
      '## Layout',
      '',
      '- `esbuild.mjs` — the bundling `theia build` runs. It keeps this file, so it is the place to adjust the bundle',
      '- `start.mjs` — `npm start`: links `../vscode-servers` into `plugins/`, then starts the backend on `THEIA_PORT`, on a folder given as its argument or `../workspace`',
      '- `playwright.config.mts` — the smoke tier, on port 4938 or `THEIA_PORT`, on a copy of `../workspace` in `smoke-workspace/`',
      '- `test/smoke.spec.mts` — Theia opens the workspace and each head answers',
      ''
   ];
   return project(lines.join('\n'), composition);
}

/** The Theia browser application: the Theia extension and the sideloaded servers extension. */
function hostTheiaBrowserFiles(composition: InitComposition): InitFile[] {
   const fixed = (file: string): InitFile => projectTemplate(`host-theia-browser/${file}`, composition);
   return [
      { path: 'host-theia-browser/package.json', content: hostTheiaBrowserPackageJson(composition) },
      ignoreFile('host-theia-browser'),
      { path: 'host-theia-browser/README.md', content: hostTheiaBrowserReadme(composition) },
      fixed('esbuild.mjs'),
      fixed('start.mjs'),
      fixed('playwright.config.mts'),
      fixed('tsconfig.e2e.json'),
      { path: 'host-theia-browser/test/smoke.spec.mts', content: theiaSmokeSpec(composition, 'browser') }
   ];
}

/**
 * The Electron smoke test's imports and its `page`: the application's window,
 * launched by the test on a scratch copy of the workspace.
 */
function theiaElectronSmokeFixture(composition: InitComposition): string {
   return `import { expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The application in Electron, on a copy of the starter workspace, since the
 * server writes its repairs to the folder it opens, with a profile of its own:
 * Theia quits at once while another window holds one. Its settings are its own
 * too, so a run never writes \`~/.theia/settings.json\`.
 */
const test = base.extend<{ page: Page }>({
   page: async ({ playwright }, use) => {
      const scratch = mkdtempSync(join(tmpdir(), '${composition.projectId}-theia-electron-'));
      const workspace = join(scratch, 'workspace');
      // The servers extension, sideloaded from a plugins folder as \`npm start\` does.
      const plugins = join(scratch, 'plugins');
      const link = join(plugins, '${composition.projectId}-vscode-servers');
      let app: ElectronApplication | undefined;
      try {
         cpSync(fileURLToPath(new URL('../../workspace', import.meta.url)), workspace, { recursive: true });
         mkdirSync(plugins);
         symlinkSync(fileURLToPath(new URL('../../vscode-servers', import.meta.url)), link, 'junction');
         // Playwright resolves Electron itself; given its path, Theia opens this
         // folder instead of the workspace.
         app = await playwright._electron.launch({
            args: [
               fileURLToPath(new URL('..', import.meta.url)),
               '--no-sandbox',
               \`--user-data-dir=\${join(scratch, 'user-data')}\`,
               // In URI form, since Theia reads the argument as a URI.
               \`--plugins=local-dir:\${pathToFileURL(plugins).pathname}\`,
               workspace
            ],
            env: {
               ...process.env,
               THEIA_CONFIG_DIR: join(scratch, 'config'),
               // Menus drawn in the page, where the test can click them.
               THEIA_ELECTRON_DISABLE_NATIVE_ELEMENTS: '1'
            }
         });
         await use(await app.firstWindow());
      } finally {
         try {
            // Exited, not closed: closing asks whether to save the edited file. An
            // app that is already gone is left alone, so the test's own error stands.
            const child = app?.process();
            if (app && child?.exitCode === null && child.signalCode === null) {
               const exited = once(child, 'exit');
               await app.evaluate(({ app: electron }) => electron.exit(0));
               await exited;
            }
         } finally {
            // Unlinked first, so the remove never reaches \`../vscode-servers\` through it.
            rmSync(link, { force: true });
            rmSync(scratch, { recursive: true, force: true });
         }
      }
   }
});
`;
}

/**
 * The Theia Electron application's `package.json`: the browser application's
 * `theia` block with the Electron target. Always private, as every host is.
 */
function hostTheiaElectronPackageJson(composition: InitComposition): string {
   const dependencies: Record<string, string> = {
      [memberPackageName(composition, 'theia')]: MEMBER_PIN,
      ...Object.fromEntries(HOST_THEIA_ELECTRON_DEPENDENCIES.map(name => [name, THEIA_VERSION]))
   };
   const devDependencies: Record<string, string> = {
      // Built before this application, whose start links it into plugins/.
      [memberPackageName(composition, 'vscode-servers')]: MEMBER_PIN,
      '@playwright/test': '^1.55.0',
      ...Object.fromEntries(HOST_THEIA_BROWSER_DEV_DEPENDENCIES.map(name => [name, THEIA_VERSION])),
      '@types/node': '^22.0.0',
      electron: ELECTRON_VERSION,
      rimraf: '^5.0.0',
      typescript: '^7.0.2'
   };
   const theia = {
      target: 'electron',
      frontend: {
         config: {
            applicationName: composition.name,
            connectionBufferBytes: 102400,
            preferences: { 'security.workspace.trust.enabled': false }
         }
      },
      backend: { config: { connectionBufferBytes: 102400, frontendConnectionTimeout: 60000 } }
   };
   return `{
  "name": "${memberPackageName(composition, 'host-theia-electron')}",
  "version": "0.0.0",
  "private": true,
  "description": "${composition.name} in a Theia Electron application: the Theia extension, and the servers extension sideloaded for the language client.",
  "license": "UNLICENSED",
  "author": "",
  "main": "lib/backend/electron-main.js",
  "scripts": {
    "build": "theia build --mode development && npm run typecheck",
    "clean": "rimraf lib src-gen plugins gen-esbuild.browser.mjs gen-esbuild.electron.mjs gen-esbuild.node.mjs test-results playwright-report",
${lintScript(forMember(composition, 'host-theia-electron'), 'test')}    "start": "node start.mjs",
    "test:e2e": "playwright test --tsconfig tsconfig.e2e.json",
    "typecheck": "tsc --noEmit -p tsconfig.e2e.json",
    "watch": "theia build --watch --mode development"
  },
  "dependencies": {
${sortedBlock(dependencies, '    ')}
  },
  "devDependencies": {
${sortedBlock(devDependencies, '    ')}
  },
  "engines": {
    "node": ">=22.13"
  },
  "theia": ${jsonAt(theia, '  ')}
}
`;
}

/** The Theia Electron application's README. */
function hostTheiaElectronReadme(composition: InitComposition): string {
   const intro = [
      `${composition.name} in a Theia Electron application: the Theia extension in \`../theia\`, and \`../vscode-servers\` sideloaded through \`@theia/plugin-ext\`, which starts the server and its language client.`,
      'Electron runs the window, and a backend process it starts runs the server.',
      ...(composition.grammars.some(grammar => grammar.diagram)
         ? ['The servers extension contributes no editor, so a diagram file opens in the Theia diagram editor alone.']
         : [])
   ];
   const lines = [
      `# ${memberPackageName(composition, 'host-theia-electron')}`,
      '',
      ...wrapProse(intro.join(' ')),
      '',
      '```bash',
      'npm run build      # bundle and type-check, and download Electron; build the members first',
      'npm run watch      # rebundle whenever the members’ builds change; reload the window to pick it up',
      'npm start          # the application on ../workspace',
      'npm run test:e2e   # the smoke test, which launches the application itself',
      '```',
      '',
      ...wrapProse(
         'There is no `theia rebuild:electron` step: Theia’s native modules are N-API builds, which load in Electron as `npm install` built them for Node.'
      ),
      '',
      ...wrapProse(
         '`npm run watch` reports a `theia-source-map-paths` JSON error as it starts: `esbuild.mjs` starts the browser and electron builds together, and they share `lib/frontend`. Later rebuilds are clean.'
      ),
      '',
      '## Layout',
      '',
      '- `esbuild.mjs` — the bundling `theia build` runs. It keeps this file, so it is the place to adjust the bundle',
      '- `start.mjs` — `npm start`: links `../vscode-servers` into `plugins/`, then starts the application on a folder given as its argument or `../workspace`',
      '- `playwright.config.mts` — the smoke tier',
      '- `test/smoke.spec.mts` — Electron opens a copy of the workspace with a profile of its own, and each head answers',
      ''
   ];
   return project(lines.join('\n'), composition);
}

/** The Theia Electron application: the browser application's extensions in a desktop window. */
function hostTheiaElectronFiles(composition: InitComposition): InitFile[] {
   const fixed = (file: string): InitFile => projectTemplate(`host-theia-electron/${file}`, composition);
   return [
      { path: 'host-theia-electron/package.json', content: hostTheiaElectronPackageJson(composition) },
      ignoreFile('host-theia-electron'),
      { path: 'host-theia-electron/README.md', content: hostTheiaElectronReadme(composition) },
      fixed('esbuild.mjs'),
      fixed('start.mjs'),
      fixed('playwright.config.mts'),
      fixed('tsconfig.e2e.json'),
      { path: 'host-theia-electron/test/smoke.spec.mts', content: theiaSmokeSpec(composition, 'electron') }
   ];
}

/**
 * The formatter and linter a standalone root runs. Exact, because a formatter
 * release that changes its output would fail the project's `format:check`.
 */
const ROOT_STYLE_DEV_DEPENDENCIES: Readonly<Record<string, string>> = { oxfmt: '0.71.0', oxlint: '1.82.0' };

/**
 * The standalone root's formatter config: the style every template is written
 * in, at the width the emitted sources wrap at. Generated code is ignored
 * because each run of its generator rewrites it in that generator's style.
 */
function oxfmtConfig(composition: InitComposition): string {
   return `{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "arrowParens": "avoid",
  "endOfLine": "lf",
  "ignorePatterns": ["**/generated", "**/generated-hydranium", "**/syntaxes", "**/*.md"],
  "jsxSingleQuote": true,
  "printWidth": ${columnsFor(composition)},
  "singleQuote": true,
  "sortPackageJson": true,
  "tabWidth": 3,
  "trailingComma": "none",
  "overrides": [
    {
      "files": ["*.json", "*.yml", "*.yaml"],
      "options": {
        "printWidth": 100,
        "tabWidth": 2
      }
    }
  ]
}
`;
}

/**
 * A standalone project's root: the members as npm workspaces.
 *
 * Always private: it is never published, whatever `--public` makes of the
 * members. npm runs a script across the members in the order listed here, not
 * by their dependencies; listing protocol first is safe because its `build`
 * runs the server's `generate` before compiling.
 *
 * It declares the exact pins `--monorepo` prints for a workspace root, for the
 * same reason: a package ranging over one, such as a framework package's peer,
 * otherwise takes the top of the tree with the newest match, and each member's
 * exact copy nests beneath it.
 *
 * `watch` keeps every non-host member built; `watch:<host>` adds one host, so
 * only the bundler of the host being worked on runs.
 *
 * `format` and `lint` run at the root over every member, which is why the
 * members get no `lint` of their own here.
 */
function rootFiles(composition: InitComposition): InitFile[] {
   const devDependencies = {
      ...Object.fromEntries(workspaceRootPins(composition)),
      concurrently: '^9.0.0',
      ...ROOT_STYLE_DEV_DEPENDENCIES
   };
   const members = initMembers(composition.heads, composition.hosts);
   // Only the server's watch is `tsc -b`, so protocol is built by one process
   // rather than two writing the same `lib/`; a host's watch joins only in its
   // own `watch:<host>`.
   const watched = members.filter(member => member !== 'protocol' && !member.startsWith('host-'));
   const parallel = (commands: Readonly<Record<string, string>>): string =>
      `concurrently --kill-others --names ${Object.keys(commands).join(',')} ${Object.values(commands)
         .map(command => `\\"${command}\\"`)
         .join(' ')}`;
   const scripts: Record<string, string> = {
      build: 'npm run build --workspaces',
      clean: 'npm run clean --workspaces --if-present',
      format: 'oxfmt',
      'format:check': 'oxfmt --check',
      lint: 'oxlint --report-unused-disable-directives --max-warnings 0',
      ...Object.fromEntries(composition.hosts.map(host => [`start:${host}`, `npm --prefix host-${host} start`])),
      test: 'npm test --workspaces --if-present',
      watch: parallel(Object.fromEntries(watched.map(member => [member, `npm --prefix ${member} run watch`]))),
      // The browser host's `start` is its watch: it rebundles the page as it serves it.
      ...Object.fromEntries(
         composition.hosts.map(host => [
            `watch:${host}`,
            parallel({
               watch: 'npm run watch',
               [`host-${host}`]: `npm --prefix host-${host} ${host === 'browser' ? 'start' : 'run watch'}`
            })
         ])
      )
   };
   const content = `{
  "name": "${composition.projectId}-root",
  "version": "0.0.0",
  "private": true,
  "workspaces": [
${members.map(member => `    "${member}"`).join(',\n')}
  ],
  "scripts": {
${Object.entries(scripts)
   .map(([name, command]) => `    "${name}": "${command}"`)
   .join(',\n')}
  },
  "devDependencies": {
${sortedBlock(devDependencies, '    ')}
  },
  "engines": {
    "node": ">=22.13"
  }
}
`;
   return [
      { path: 'package.json', content },
      ignoreFile(''),
      { path: '.editorconfig', content: template('editorconfig') },
      { path: '.oxfmtrc.json', content: oxfmtConfig(composition) },
      { path: '.oxlintrc.json', content: template('oxlintrc.json') }
   ];
}

/**
 * Every file the scaffold emits, fully rendered, at its path in the project
 * directory. A workspace member's project gets no root of its own: it joins the
 * surrounding workspace, whose manifest `init` prints the changes for.
 */
export function buildInitTemplates(composition: InitComposition): InitFile[] {
   return [
      ...(composition.packaging.workspace === undefined ? rootFiles(composition) : []),
      ...protocolFiles(composition),
      ...serverFiles(composition),
      ...(composition.heads.includes('glsp') ? clientFiles(composition) : []),
      ...(emitsVscodeServers(composition) ? vscodeServersFiles(composition) : []),
      ...(composition.hosts.some(isTheiaHost) ? theiaFiles(composition) : []),
      ...(composition.hosts.includes('browser') ? hostBrowserFiles(composition) : []),
      ...(composition.hosts.includes('vscode') ? hostVscodeFiles(composition) : []),
      ...(composition.hosts.includes('theia-browser') ? hostTheiaBrowserFiles(composition) : []),
      ...(composition.hosts.includes('theia-electron') ? hostTheiaElectronFiles(composition) : []),
      ...workspaceFiles(composition)
   ];
}
