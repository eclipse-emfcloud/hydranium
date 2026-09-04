/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// @ts-check

const fs = require('node:fs');
const path = require('node:path');
const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const importPlugin = require('eslint-plugin-import');
const prettierConfig = require('eslint-config-prettier');

/**
 * Workspace package directories, expanded from the root manifest.
 *
 * Read rather than listed so the per-package test blocks below cannot fall
 * behind the workspace: a new package gets the rule by existing.
 */
function workspacePackageDirs() {
   const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
   /** @type {string[]} */
   const entries = manifest.workspaces ?? [];
   return entries.flatMap(entry => {
      if (!entry.includes('*')) {
         return fs.existsSync(path.join(__dirname, entry, 'package.json')) ? [entry] : [];
      }
      const base = entry.split('/*')[0];
      return fs
         .readdirSync(path.join(__dirname, base), { withFileTypes: true })
         .filter(child => child.isDirectory() && fs.existsSync(path.join(__dirname, base, child.name, 'package.json')))
         .map(child => `${base}/${child.name}`);
   });
}

/**
 * The phantom-dependency rule over a package's TEST tree.
 *
 * One config block per package, because the option that makes this work is
 * `packageDir` and it has to name two directories: the package AND the repo
 * root. A test legitimately reaches both — `vitest` and `@playwright/test` are
 * root devDependencies shared by every suite, while a fixture may use the
 * package's own dependency — so a single static block cannot express it. Pointed
 * at the root alone, every package's own dependency looks extraneous; pointed at
 * the package alone, `vitest` does, which is 251 false positives and why the
 * naive widening was abandoned. Naming both leaves exactly the real defect:
 * a package imported in a test and declared in NEITHER manifest.
 *
 * `devDependencies: true`, unlike the `src` block: a test SHOULD use them. The
 * claim here is narrower than the one about `src` — not "this would break a
 * consumer" but "this resolves only through workspace hoisting, and would stop
 * the day the tree is installed differently".
 *
 * Why the `src` block's reasoning does not cover this. Its comment says a
 * phantom import in a test "fails the test run on the spot anyway", which holds
 * for suites inside `check` — but the Playwright tiers are deliberately OUTSIDE
 * `check`, so there a phantom import fails nothing until someone runs the tier
 * by hand. That is exactly how the Theia app's e2e spec came to resolve the
 * example server through hoisting alone.
 */
/** @type {import('typescript-eslint').ConfigArray} */
const testTreePhantomDependencyBlocks = workspacePackageDirs().map(
   /** @param {string} packageDir */ packageDir => ({
      files: [`${packageDir}/test/**/*.ts`, `${packageDir}/test/**/*.tsx`, `${packageDir}/test/**/*.mts`],
      ignores: ['**/generated/**'],
      rules: {
         'import/no-extraneous-dependencies': [
            'warn',
            {
               devDependencies: true,
               optionalDependencies: false,
               peerDependencies: true,
               includeTypes: true,
               packageDir: [path.join(__dirname, packageDir), __dirname]
            }
         ]
      }
   })
);

// Chokepoint discipline: @hydranium/* framework packages import Langium
// via @hydranium/langium, never the upstream `langium` / `vscode-uri` packages
// directly. Identity (single physical copy) is guaranteed by the root pin, but
// the chokepoint is the seam for version governance and future augmentation.
// packages/langium IS the chokepoint and is exempt (see the ignores below).
const RESTRICT_DIRECT_LANGIUM_PATHS = [
   { name: 'langium', message: 'Import Langium via the @hydranium/langium chokepoint, not the upstream package directly.' },
   { name: 'langium/lsp', message: 'Import via @hydranium/langium/lsp (the chokepoint), not langium/lsp directly.' },
   { name: 'langium/node', message: 'Import via @hydranium/langium/node (the chokepoint), not langium/node directly.' },
   { name: 'langium/test', message: 'Import via @hydranium/langium/test (the chokepoint), not langium/test directly.' },
   { name: 'vscode-uri', message: 'Import URI via @hydranium/langium, which re-exports it (Langium owns the vscode-uri version).' }
];

// Head-neutrality: head-neutral code may use LSP *types* but not *values* — a
// value import couples to the LSP-textual protocol at runtime. Now phrased
// against the chokepoint subpath the LSP defaults are re-exported through.
const RESTRICT_LSP_VALUE = {
   name: '@hydranium/langium/lsp',
   message:
      'Head-neutral packages only accept type imports from @hydranium/langium/lsp. Value imports couple to the LSP-textual protocol at runtime.',
   allowTypeImports: true
};

const RESTRICT_DIRECT_LANGIUM = { paths: RESTRICT_DIRECT_LANGIUM_PATHS };
const RESTRICT_HEAD_NEUTRAL = { paths: [...RESTRICT_DIRECT_LANGIUM_PATHS, RESTRICT_LSP_VALUE] };

// Neutrality: a head's portable `.` surface runs in BOTH Node and the
// browser, so it must not import `node:*` builtins (nor GLSP's `/node` subpath).
// Node-only code lives under `src/node/` (the `./node` subpath), `src/testing/`
// is test-only — both are excluded below. `node:*` is the codebase convention
// for builtins; bare `'path'` stays allowed (the one browser-aliasable seam,
// see initialize-workspace.ts). DOM-freedom is enforced separately by
// `lib: ["ES2022"]` in tsconfig.base.json. The committed `check:neutral` esbuild
// probe is the backstop for TRANSITIVE node pollution this per-file rule can't see.
// The upstream BROWSER build — the mirror of the `/node` ban below, and banned
// for the same reason rather than the opposite one. A neutral file naming
// either has PICKED a platform; the `.` entry must resolve under both, and
// `@eclipse-glsp/server`'s own `browser` field is what swaps the build behind
// the bare specifier. The worker launcher lives under src/browser/, which is
// exempt.
const RESTRICT_GLSP_BROWSER_BUILD = {
   group: ['@eclipse-glsp/server/browser', '@eclipse-glsp/server/browser.js'],
   message:
      'Neutral GLSP code imports the bare @eclipse-glsp/server (the `browser` field swaps the build); the worker launcher lives under src/browser/.'
};

const RESTRICT_NEUTRAL_PATTERNS = [
   {
      group: ['node:*'],
      message: 'Neutral (`.`-entry) code must not import node:* builtins — move node-only code under src/node/ (the `./node` subpath).'
   },
   {
      group: ['@eclipse-glsp/server/node', '@eclipse-glsp/server/node.js'],
      message:
         'Neutral GLSP code imports the bare @eclipse-glsp/server (browser-swappable); the node socket launcher lives under src/node/.'
   },
   RESTRICT_GLSP_BROWSER_BUILD,
   {
      // Our OWN `/node` subpaths were the gap. The two bans above cover Node
      // builtins and one third-party subpath, so a neutral file importing a
      // SIBLING framework package's node surface passed lint, passed
      // check:neutral (which externalised bare deps) and only failed when
      // somebody finally bundled the head for a browser. Reach a sibling's
      // node code from src/node/, which is exempt, and let the platform
      // default swap it.
      group: ['@hydranium/*/node', '@hydranium/*/node.js'],
      message:
         "Neutral (`.`-entry) code must not import a sibling package's /node subpath — it pulls that package's node:* imports into every browser bundle. Move the use under src/node/."
   }
];

// Merge the neutral patterns into an existing langium restriction (the
// no-restricted-imports rule replaces per-scope, so the patterns ride along).
/** @param {{ paths?: unknown[], patterns?: unknown[] }} restriction */
const withNeutral = restriction => ({ ...restriction, patterns: [...(restriction.patterns ?? []), ...RESTRICT_NEUTRAL_PATTERNS] });

// For a PLATFORM subtree: everything neutral code is banned from except the one
// build that subtree exists to name. Not the same as the `src/node/` exemption
// further below, which drops the neutral patterns wholesale — a browser-only
// entry still must not import `node:*`, and a browser bundle is precisely where
// such an import breaks, so it keeps every ban but one.
/**
 * @param {{ paths?: unknown[], patterns?: unknown[] }} restriction
 * @param {unknown[]} allowed
 */
const withNeutralExcept = (restriction, ...allowed) => ({
   ...restriction,
   patterns: [...(restriction.patterns ?? []), ...RESTRICT_NEUTRAL_PATTERNS.filter(pattern => !allowed.includes(pattern))]
});

// Neutral code never touches a Node-only GLOBAL directly — it goes through a
// guarded accessor in `util/environment.ts` (the lone exempt module), so it
// degrades in a browser. `node:*` IMPORTS are banned above; globals aren't
// imports, so the probe can't see them — the `no-restricted-globals` rule below
// (inlined to keep its tuple type) is their static guard.
const RESTRICT_PROCESS_GLOBAL_MSG =
   'Neutral code must not use `process` directly — go through a guarded accessor in util/environment.ts (processEnv/processPid/onProcessEvent/currentMemoryUsage).';

const RESTRICT_BUFFER_GLOBAL_MSG = 'Neutral code must not use the Node-only `Buffer` global directly.';

// The head-neutral packages carry no HOST framework — no editor and no
// rendering client — values or types alike. A type import still needs the host
// installed to typecheck, which puts it in the neutral tier's devDependencies,
// and it is one keystroke from a value import — so the ban is on the specifier
// and ignores the import kind. That is why it rides the BASE
// `no-restricted-imports` rule: the typescript-eslint one is spoken for by the
// langium-chokepoint and neutrality blocks, it replaces per-scope rather than
// merging, and it can be relaxed for types. The patterns need no `/**` sibling
// — they are matched under gitignore semantics, so `@theia/*` already covers
// `@theia/core/shared/inversify`.
//
// WHAT THE LIST DELIBERATELY LEAVES OUT, because the near-misses are the wire
// protocol the heads are built ON and a reader who "fixes" this list breaks
// every one of them:
//   -- `vscode-*` is NOT banned and must not be. `vscode-languageserver`,
//      `vscode-jsonrpc`, `vscode-languageserver-{textdocument,types,protocol}`
//      and their `/node` and `/browser` subpaths are host-neutral protocol
//      libraries, and the four packages import them heavily. Only the bare
//      `vscode` module — the editor extension API, which exists nowhere but
//      inside VS Code — is banned. Under gitignore semantics a bare `vscode`
//      matches `vscode` and `vscode/…` and NOTHING else, so it cannot reach a
//      `vscode-` sibling; a `vscode*` prefix pattern would ban them all.
//   -- `@eclipse-glsp/*` is NOT banned wholesale. `@eclipse-glsp/server` and
//      `@eclipse-glsp/protocol` are what the GLSP head IS. Only the two
//      host-side entries are banned: `@eclipse-glsp/client` is the sprotty
//      renderer and `@eclipse-glsp/theia-integration` is a Theia frontend.
const RESTRICT_HOST_FRAMEWORK_MSG =
   'Head-neutral packages must not import a host framework (@theia/*, `vscode`, @eclipse-glsp/client, @eclipse-glsp/theia-integration), not even as a type — host-bound code belongs in the packages/*-theia tier. The `vscode-*` protocol libraries and @eclipse-glsp/{server,protocol} are host-neutral and stay allowed.';

// The THIRD place "generated code is exempt" has to be said, after
// `.prettierignore` and `HEADER_EXEMPT` in `scripts/header.mjs`. All three name
// `generated` AND `generated-transfer` — the latter is
// `hydranium-cli generate-transfer-model` output, kept out of `generated/`
// because langium-cli treats its own output directory as exclusively its own and
// offers to delete strangers. Adding a generated directory means editing all
// three lists; missing this one is what surfaced a dead eslint-disable directive
// in code nothing should have been linting.
const GENERATED_DIRS = ['**/generated/**', '**/generated-transfer/**'];

module.exports = tseslint.config(
   {
      ignores: ['**/node_modules', '**/lib', '**/dist', '**/out', '**/*.d.ts', ...GENERATED_DIRS, '**/.yalc']
   },

   // Baseline applies to every TS file in the workspace.
   eslint.configs.recommended,
   ...tseslint.configs.recommended,
   importPlugin.flatConfigs.recommended,
   importPlugin.flatConfigs.typescript,
   prettierConfig,

   {
      languageOptions: {
         ecmaVersion: 2022,
         sourceType: 'module',
         globals: {
            // Node globals — covers process, require, console, etc. without
            // pulling the whole eslint/globals package.
            process: 'readonly',
            require: 'readonly',
            module: 'readonly',
            __dirname: 'readonly',
            __filename: 'readonly',
            console: 'readonly',
            Buffer: 'readonly'
         }
      },
      settings: {
         'import/resolver': {
            typescript: {
               alwaysTryTypes: true,
               // Both example depths — see the note on the
               // `import/no-extraneous-dependencies` block below.
               project: ['packages/*/tsconfig.json', 'examples/*/tsconfig.json', 'examples/*/*/tsconfig.json']
            }
         }
      },
      rules: {
         '@typescript-eslint/no-explicit-any': 'warn',
         '@typescript-eslint/no-unused-vars': [
            'warn',
            {
               argsIgnorePattern: '^_',
               caughtErrorsIgnorePattern: '^_',
               varsIgnorePattern: '^_',
               destructuredArrayIgnorePattern: '^_'
            }
         ],
         // The interface + namespace declaration-merging pattern is idiomatic
         // across Theia, GLSP, EMF Cloud, and vscode-jsonrpc. Allow it.
         '@typescript-eslint/no-namespace': 'off',
         // Type-only imports must use `import type` — keeps the head-neutral
         // type-vs-value discipline the no-restricted-imports rule relies on
         // (a type-only langium import erases; a value import couples).
         '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }]
      }
   },

   // Phantom-dependency gate: a package may only import what its OWN
   // package.json declares. npm's flat hoisting makes an undeclared dependency
   // resolve fine in this workspace and fail for a published consumer, which is
   // exactly the class a sweep cleared once (40 unlisted deps → 0) with nothing
   // stopping it coming back. The rule resolves each file against the nearest
   // package.json, which under `packages/*/src` is the package's own.
   // `peerDependencies` counts as declared — that is how the intra-framework
   // @hydranium/* edges are expressed (their "*" ranges are this gate's other half).
   //
   // `src` ONLY, deliberately: `src` is what ships, so it is where an undeclared
   // import becomes a consumer's broken install. Test files are excluded because
   // their dev tooling (vitest and friends) is declared once at the workspace
   // root by design — pointing the rule at the root package.json to accept that
   // would also make every root devDependency look declared to `src`, which is
   // the hole this gate exists to close. A phantom import in a test fails the
   // test run on the spot anyway. `src/testing/**` IS covered: it ships as the
   // `/testing` subpath.
   // Adopters are covered too (2026-08-27). `examples/order-flow/server` imported
   // five GLSP-head packages it did not declare and worked only through workspace
   // hoisting — and `init-templates.ts` derives from that example, so the omission
   // was inherited by every scaffolded project. `generated` directories are exempt
   // for the same reason as the chokepoint ban: langium-cli owns them.
   //
   // TWO example depths, and both are load-bearing. `examples/` holds a
   // multi-package family, which groups its hosts a level down
   // (`examples/<family>/<host>/src`), and may equally hold a single-package
   // example sitting directly under `examples/`. A `*` does not cross a
   // separator, so a pattern for one shape matches NOTHING of the other — and an
   // unmatched `files` glob leaves the rule unset rather than passing, which
   // `--max-warnings 0` cannot distinguish from clean.
   {
      files: [
         'packages/*/src/**/*.ts',
         'packages/*/src/**/*.tsx',
         'examples/*/src/**/*.ts',
         'examples/*/src/**/*.tsx',
         'examples/*/*/src/**/*.ts',
         'examples/*/*/src/**/*.tsx'
      ],
      ignores: ['**/generated/**'],
      rules: {
         'import/no-extraneous-dependencies': [
            'warn',
            { devDependencies: false, optionalDependencies: false, peerDependencies: true, includeTypes: true }
         ]
      }
   },

   // The TEST-tree half of the same rule, one block per package — see
   // `testTreePhantomDependencyBlocks` for why it cannot be a single block.
   ...testTreePhantomDependencyBlocks,

   // A VS Code extension imports `vscode`, which the HOST provides at runtime and
   // which is typed from `@types/vscode` in devDependencies. Declaring it as a
   // runtime dependency would be wrong (npm would try to install it), so
   // `devDependencies: true` here is the correct shape rather than an exemption
   // for convenience. Scoped to the packages that have a host-provided module.
   {
      files: ['examples/order-flow/vscode/src/**/*.ts', 'examples/order-flow/vscode-servers/src/**/*.ts'],
      rules: {
         'import/no-extraneous-dependencies': [
            'warn',
            { devDependencies: true, optionalDependencies: false, peerDependencies: true, includeTypes: true }
         ]
      }
   },

   // Chokepoint ban: Langium is consumed via @hydranium/langium, never
   // directly. packages/langium is the chokepoint and is exempt.
   //
   // ADOPTERS ARE COVERED TOO (Martin's call, 2026-08-27). Soft enforcement was
   // tried first — "adopters import langium directly if they wish" — and the
   // examples in the tree disagreed with each other about what that meant, which
   // is the signal that the choice does not belong to the adopter. The reason to
   // enforce it is VERSION COUPLING, not runtime
   // identity: `langium` sits in an atomic chain with vscode-languageserver /
   // -protocol / -jsonrpc (see the //langium note in the root package.json), and
   // an adopter importing it directly owns that pin itself and can drift out of
   // lockstep. Going through the chokepoint makes the framework own it. The
   // chokepoint is also where a Langium rename would be defensively patched, so
   // direct importers get no shield.
   //
   // GENERATED CODE IS EXEMPT AND MUST BE: langium-cli emits `generated/ast.ts`,
   // `grammar.ts` and `module.ts` with direct `langium` imports, and regenerates
   // them on every build, so a violation there is not fixable in the tree. Those
   // files are why `langium` STAYS a declared dependency of every adopter.
   {
      files: ['packages/**/*.ts', 'packages/**/*.tsx', 'examples/**/*.ts', 'examples/**/*.tsx'],
      ignores: ['packages/langium/**', '**/generated/**'],
      rules: {
         '@typescript-eslint/no-restricted-imports': ['warn', RESTRICT_DIRECT_LANGIUM]
      }
   },

   // @hydranium/core's AST coordination layer (everything OUTSIDE src/lsp/)
   // stays head-neutral: it does NOT runtime-depend on the LSP defaults because
   // the framework supports headless configurations. Type imports erase at
   // compile time and stay allowed. src/lsp/ and integration-services.ts are
   // the composition seams — they value-import the LSP head freely (override
   // further below).
   {
      files: ['packages/core/src/**/*.ts'],
      rules: {
         '@typescript-eslint/no-restricted-imports': ['warn', withNeutral(RESTRICT_HEAD_NEUTRAL)]
      }
   },
   {
      files: ['packages/core/src/lsp/**/*.ts', 'packages/core/src/langium/integration-services.ts'],
      rules: {
         // Still chokepoint-banned from direct langium, but the LSP head's
         // values are allowed here (this is the composition seam). Neutral —
         // the LSP head must run in a browser worker too, so node: stays banned.
         '@typescript-eslint/no-restricted-imports': ['warn', withNeutral(RESTRICT_DIRECT_LANGIUM)]
      }
   },

   // @hydranium/data-server is the typed-RPC head — a peer of glsp-server and
   // of the LSP head at @hydranium/core/lsp. Value imports of the LSP defaults
   // would couple the data-server to the LSP-textual protocol at runtime.
   {
      files: ['packages/data-server/src/**/*.ts'],
      rules: {
         '@typescript-eslint/no-restricted-imports': ['warn', withNeutral(RESTRICT_HEAD_NEUTRAL)]
      }
   },

   // @hydranium/glsp-server is the GLSP head — same head-neutrality rule.
   {
      files: ['packages/glsp-server/src/**/*.ts'],
      rules: {
         '@typescript-eslint/no-restricted-imports': ['warn', withNeutral(RESTRICT_HEAD_NEUTRAL)]
      }
   },

   // The GLSP head's browser-only subtree (the `./browser` subpath, holding the
   // worker launcher). It names the upstream browser build by design and stays
   // banned from everything else — `node:*` and a sibling's `/node` above all,
   // since a browser bundle is exactly where those break.
   {
      files: ['packages/glsp-server/src/browser/**/*.ts'],
      rules: {
         '@typescript-eslint/no-restricted-imports': ['warn', withNeutralExcept(RESTRICT_HEAD_NEUTRAL, RESTRICT_GLSP_BROWSER_BUILD)]
      }
   },

   // @hydranium/protocol is the neutral shared-contract layer (types, constants,
   // transfer model) — node-import-banned like the heads. It never imports
   // langium directly either, so the langium ban rides along as a no-op.
   {
      files: ['packages/protocol/src/**/*.ts'],
      rules: {
         '@typescript-eslint/no-restricted-imports': ['warn', withNeutral(RESTRICT_DIRECT_LANGIUM)]
      }
   },

   // The host-framework ban, over the WHOLE of each head-neutral package rather
   // than its neutral surfaces alone. `check:neutral` cannot see this one at
   // all: it marks a bare third-party specifier external and then judges the
   // externalised set by name against a Node-only predicate, which `@theia/core`
   // does not satisfy. Whole packages because the argument is about the
   // MANIFEST — one devDependency serves `src/`, `src/node/`, `src/testing/`
   // and `test/` alike, so exempting a tier would leave the host installed for
   // the neutral one anyway.
   {
      files: [
         'packages/core/src/**/*.ts',
         'packages/core/test/**/*.ts',
         'packages/data-server/src/**/*.ts',
         'packages/data-server/test/**/*.ts',
         'packages/glsp-server/src/**/*.ts',
         'packages/glsp-server/test/**/*.ts',
         'packages/protocol/src/**/*.ts',
         'packages/protocol/test/**/*.ts'
      ],
      rules: {
         'no-restricted-imports': [
            'warn',
            {
               patterns: [
                  {
                     group: ['@theia/*', 'vscode', '@eclipse-glsp/client', '@eclipse-glsp/theia-integration'],
                     message: RESTRICT_HOST_FRAMEWORK_MSG
                  }
               ]
            }
         ]
      }
   },

   // No raw Node globals on any neutral surface — `process` / `Buffer` go through
   // the guarded accessors in util/environment.ts (exempt below).
   {
      files: [
         'packages/core/src/**/*.ts',
         'packages/data-server/src/**/*.ts',
         'packages/glsp-server/src/**/*.ts',
         'packages/protocol/src/**/*.ts',
         // The five packages below also publish gated browser-neutral entries,
         // and the esbuild probe that gates them cannot see a global at all —
         // only an import. So without this rule a `process.env` read on one of
         // their neutral surfaces passes every gate in the repository and then
         // throws in a Theia frontend.
         'packages/langium/src/**/*.ts',
         'packages/conformance/src/**/*.ts',
         'packages/client-theia/src/**/*.ts',
         'packages/glsp-client-theia/src/**/*.ts',
         'packages/data-client-theia/src/**/*.ts'
      ],
      rules: {
         'no-restricted-globals': [
            'warn',
            { name: 'process', message: RESTRICT_PROCESS_GLOBAL_MSG },
            { name: 'Buffer', message: RESTRICT_BUFFER_GLOBAL_MSG }
         ]
      }
   },

   // The `src/node/` (server-only, the `./node` subpath) and `src/testing/`
   // (test-only) subtrees are NOT on the neutral surface — they may import
   // node:* / @eclipse-glsp/server/node and use Node globals freely. Revert the
   // import ban to langium-only and drop the global ban (last match wins).
   {
      files: [
         'packages/core/src/node/**/*.ts',
         'packages/core/src/testing/**/*.ts',
         'packages/data-server/src/node/**/*.ts',
         'packages/data-server/src/testing/**/*.ts',
         'packages/glsp-server/src/node/**/*.ts',
         'packages/glsp-server/src/testing/**/*.ts',
         'packages/protocol/src/testing/**/*.ts'
      ],
      rules: {
         '@typescript-eslint/no-restricted-imports': ['warn', RESTRICT_HEAD_NEUTRAL],
         'no-restricted-globals': 'off'
      }
   },

   // Three of the `src/testing/` trees the block above just exempted publish a
   // subpath `check:neutral` gates as BROWSER-NEUTRAL, so the global ban comes
   // straight back for them — the exemption above is right for a Node-bound
   // test tier and wrong for a gated one. Same argument as the five packages
   // added to the ban further up: the esbuild probe cannot see a global at all,
   // only an import, so a `process.env` read here passes every gate in the
   // repository and then throws in a browser-hosted test tier. The IMPORT rules
   // stay as the block above set them, since an import is exactly what the
   // probe does catch.
   //
   // The `node/` and `playwright/` subtrees keep the exemption: they are the
   // deliberately Node-bound halves and no gated entry's graph reaches them.
   {
      files: ['packages/core/src/testing/**/*.ts', 'packages/glsp-server/src/testing/**/*.ts', 'packages/protocol/src/testing/**/*.ts'],
      ignores: [
         'packages/core/src/testing/node/**/*.ts',
         'packages/core/src/testing/playwright/**/*.ts',
         'packages/protocol/src/testing/node/**/*.ts'
      ],
      rules: {
         'no-restricted-globals': [
            'warn',
            { name: 'process', message: RESTRICT_PROCESS_GLOBAL_MSG },
            { name: 'Buffer', message: RESTRICT_BUFFER_GLOBAL_MSG }
         ]
      }
   },

   // The Node tiers of the packages added to the global ban above. Only the
   // GLOBAL ban is lifted here: their import rules are left exactly as the
   // blocks above set them, because a block that also restated
   // `no-restricted-imports` would re-apply the langium ban to
   // `packages/langium`, which is the chokepoint and is deliberately exempt.
   {
      files: [
         'packages/client-theia/src/node/**/*.ts',
         'packages/glsp-client-theia/src/node/**/*.ts',
         'packages/data-client-theia/src/node/**/*.ts'
      ],
      rules: {
         'no-restricted-globals': 'off'
      }
   },

   // util/environment.ts IS the guarded Node-global accessor — the lone neutral
   // module allowed to touch `process` (it keeps the node:* import ban).
   {
      files: ['packages/core/src/util/environment.ts'],
      rules: {
         'no-restricted-globals': 'off'
      }
   },

   // Test-fixture consolidation guard. The shared builders in
   // `@hydranium/core/testing` (makeFakeAstNode / makeFakeDocument /
   // makeFakeDescription / makeFakeReflection) replaced per-file fixture builders
   // that were copy-pasted across suites. Ban re-declaring a local one under the
   // canonical names so the duplication doesn't creep back — import the shared
   // helper instead. (Catches re-invention by name; it can't catch an
   // arbitrarily-renamed copy — the convention doc is the backstop for that.)
   //
   // The cast-level ban is per-type, added only for the cast FORM whose
   // test-tree count has reached zero. `AstNodeDescription`, `Logger`,
   // `ServerSharedServicesMinimal`, and `GlspLogger` are clean in both forms:
   // every description routes through makeFakeDescription, every logger stub
   // through makeNoopLogger / makeCapturingLogger (or a vi.spyOn on a real logger
   // / makeNoopTracer for the Tracer slot), every partial shared-services tree
   // through makeNoopSharedServices, and every GLSP logger through
   // makeNoopGlspLogger / makeCapturingGlspLogger, so any such `x as T` signals
   // drift. `AstNode` is clean only in the DOUBLE-cast
   // form (`x as unknown as AstNode` = 0 after every object-literal fixture
   // moved to makeFakeAstNode), so we ban just that form; bare `{} as AstNode`
   // (no `$type`, degenerate — the code reads one field) stays allowed.
   // `LangiumDocument` / `AstReflection` still carry legitimate minimal casts (a
   // stub reads one field, or implements reflection methods the builder does not
   // model), so no ban yet — revisit as each drops to zero. An intersection cast
   // (`x as AstNodeDescription & { … }`) is a structural extension, not a
   // fixture, and is not matched.
   {
      files: ['packages/**/test/**/*.ts'],
      rules: {
         'no-restricted-syntax': [
            'warn',
            {
               selector:
                  'FunctionDeclaration[id.name=/^(fakeNode|makeNode|fakeReflection|makeDescription|makeNoopLogger|makeCapturingLogger|makeNoopTracer|makeCapturingTracer|makeNoopSharedServices|makeNoopLanguageServices|makeNoopGlspLogger|makeCapturingGlspLogger)$/]',
               message:
                  'Import the shared makeFake* / makeNoop* / makeCapturing* helpers from @hydranium/core/testing (or @hydranium/glsp-server/testing for the GLSP ones) instead of re-declaring a local fixture builder (see docs/contributing/conventions.md “Test support”).'
            },
            {
               selector:
                  'VariableDeclarator[id.name=/^(fakeNode|makeNode|fakeReflection|makeDescription|makeNoopLogger|makeCapturingLogger|makeNoopTracer|makeCapturingTracer|makeNoopSharedServices|makeNoopLanguageServices|makeNoopGlspLogger|makeCapturingGlspLogger)$/][init.type=/^(Arrow)?FunctionExpression$/]',
               message:
                  'Import the shared makeFake* / makeNoop* / makeCapturing* helpers from @hydranium/core/testing (or @hydranium/glsp-server/testing for the GLSP ones) instead of re-declaring a local fixture builder (see docs/contributing/conventions.md “Test support”).'
            },
            {
               selector: 'TSAsExpression[typeAnnotation.type="TSTypeReference"][typeAnnotation.typeName.name="AstNodeDescription"]',
               message:
                  'Build AstNodeDescription fixtures with makeFakeDescription from @hydranium/core/testing instead of casting an object literal (see docs/contributing/conventions.md “Test support”).'
            },
            {
               selector:
                  'TSAsExpression[typeAnnotation.type="TSTypeReference"][typeAnnotation.typeName.name="AstNode"][expression.type="TSAsExpression"][expression.typeAnnotation.type="TSUnknownKeyword"]',
               message:
                  'Build AstNode fixtures with makeFakeAstNode from @hydranium/core/testing instead of a `… as unknown as AstNode` double cast (see docs/contributing/conventions.md “Test support”).'
            },
            {
               selector: 'TSAsExpression[typeAnnotation.type="TSTypeReference"][typeAnnotation.typeName.name="Logger"]',
               message:
                  'Build Logger fixtures with makeNoopLogger / makeCapturingLogger from @hydranium/core/testing (or spy a real logger with vi.spyOn) instead of casting an object literal (see docs/contributing/conventions.md “Test support”).'
            },
            {
               selector:
                  'TSAsExpression[typeAnnotation.type="TSTypeReference"][typeAnnotation.typeName.name="ServerSharedServicesMinimal"]',
               message:
                  'Build a shared-services tree with makeNoopSharedServices from @hydranium/core/testing (overrides are loosely typed for stubs) instead of casting an object literal (see docs/contributing/conventions.md “Test support”).'
            },
            {
               selector: 'TSAsExpression[typeAnnotation.type="TSTypeReference"][typeAnnotation.typeName.name="GlspLogger"]',
               message:
                  'Build GLSP logger fixtures with makeNoopGlspLogger / makeCapturingGlspLogger from @hydranium/glsp-server/testing instead of casting an object literal (see docs/contributing/conventions.md “Test support”).'
            }
         ]
      }
   }
);
