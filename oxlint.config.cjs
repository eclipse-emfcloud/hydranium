/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// @ts-check

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

// Oxlint matches a `group` entry as a plain glob, so `node:*` misses
// `node:fs/promises` and `@theia/*` misses `@theia/core/shared/inversify`
// unless the entry also lists its `/**` subpaths.
/** @param {string[]} patterns */
const withSubpaths = patterns => patterns.flatMap(pattern => [pattern, `${pattern}/**`]);

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
   group: withSubpaths(['@eclipse-glsp/server/browser', '@eclipse-glsp/server/browser.js']),
   message:
      'Neutral GLSP code imports the bare @eclipse-glsp/server (the `browser` field swaps the build); the worker launcher lives under src/browser/.'
};

const RESTRICT_NEUTRAL_PATTERNS = [
   {
      group: withSubpaths(['node:*']),
      message: 'Neutral (`.`-entry) code must not import node:* builtins — move node-only code under src/node/ (the `./node` subpath).'
   },
   {
      group: withSubpaths(['@eclipse-glsp/server/node', '@eclipse-glsp/server/node.js']),
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
      group: withSubpaths(['@hydranium/*/node', '@hydranium/*/node.js']),
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
// and ignores the import kind. A later block replaces `no-restricted-imports`
// rather than merging into it, so `withHost` adds this pattern to every block
// covering these packages; a block that omits it lifts the ban for its files.
//
// WHAT THE LIST DELIBERATELY LEAVES OUT, because the near-misses are the wire
// protocol the heads are built ON and a reader who "fixes" this list breaks
// every one of them:
//   -- `vscode-*` is NOT banned and must not be. `vscode-languageserver`,
//      `vscode-jsonrpc`, `vscode-languageserver-{textdocument,types,protocol}`
//      and their `/node` and `/browser` subpaths are host-neutral protocol
//      libraries, and the four packages import them heavily. Only the bare
//      `vscode` module — the editor extension API, which exists nowhere but
//      inside VS Code — is banned. `vscode` with its `/**` subpaths matches
//      `vscode` and `vscode/…` and NOTHING else, so it cannot reach a
//      `vscode-` sibling; a `vscode*` prefix pattern would ban them all.
//   -- `@eclipse-glsp/*` is NOT banned wholesale. `@eclipse-glsp/server` and
//      `@eclipse-glsp/protocol` are what the GLSP head IS. Only the two
//      host-side entries are banned: `@eclipse-glsp/client` is the sprotty
//      renderer and `@eclipse-glsp/theia-integration` is a Theia frontend.
const RESTRICT_HOST_FRAMEWORK_MSG =
   'Head-neutral packages must not import a host framework (@theia/*, `vscode`, @eclipse-glsp/client, @eclipse-glsp/theia-integration), not even as a type — host-bound code belongs in the packages/*-theia tier. The `vscode-*` protocol libraries and @eclipse-glsp/{server,protocol} are host-neutral and stay allowed.';

const RESTRICT_HOST_FRAMEWORK = {
   group: withSubpaths(['@theia/*', 'vscode', '@eclipse-glsp/client', '@eclipse-glsp/theia-integration']),
   message: RESTRICT_HOST_FRAMEWORK_MSG
};

/** @param {{ paths?: unknown[], patterns?: unknown[] }} restriction */
const withHost = restriction => ({ ...restriction, patterns: [...(restriction.patterns ?? []), RESTRICT_HOST_FRAMEWORK] });

// The THIRD place "generated code is exempt" has to be said, after
// `.prettierignore` and `HEADER_EXEMPT` in `scripts/header.mjs`. All three name
// `generated` AND `generated-hydranium` — the latter is `hydranium-cli` output,
// named for the tool that owns it rather than for one artefact, kept out of
// `generated/` because langium-cli deletes that directory outright on every run
// and prompts about strangers. Adding a generated directory means editing all
// three lists; missing this one is what surfaced a dead eslint-disable directive
// in code nothing should have been linting.
const GENERATED_DIRS = ['**/generated/**', '**/generated-hydranium/**'];

// Repository-specific scopes; excludeFiles preserves the former per-block ignores.
const policyOverrides = [
   {
      ignores: ['**/node_modules', '**/lib', '**/dist', '**/out', '**/*.d.ts', ...GENERATED_DIRS]
   },

   // Baseline applies to every TS file in the workspace.

   // A `.cjs` file cannot use `import`, so the baseline's ban on `require()` is
   // unsatisfiable there rather than merely inconvenient. The extension is the
   // whole condition: it is chosen only where CommonJS is forced, which for a
   // `--require` preload it is — Node's `--require` cannot load an ES module.
   {
      files: ['**/*.cjs'],
      rules: {
         'typescript/no-require-imports': 'off'
      }
   },

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
      rules: {
         'typescript/no-explicit-any': 'warn',
         'no-unused-vars': [
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
         'typescript/no-namespace': 'off',
         // Type-only imports must use `import type` — keeps the head-neutral
         // type-vs-value discipline the no-restricted-imports rule relies on
         // (a type-only langium import erases; a value import couples).
         'typescript/consistent-type-imports': ['warn', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }]
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
         'no-restricted-imports': ['warn', RESTRICT_DIRECT_LANGIUM]
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
         'no-restricted-imports': ['warn', withHost(withNeutral(RESTRICT_HEAD_NEUTRAL))]
      }
   },
   {
      files: ['packages/core/src/lsp/**/*.ts', 'packages/core/src/langium/integration-services.ts'],
      rules: {
         // Still chokepoint-banned from direct langium, but the LSP head's
         // values are allowed here (this is the composition seam). Neutral —
         // the LSP head must run in a browser worker too, so node: stays banned.
         'no-restricted-imports': ['warn', withHost(withNeutral(RESTRICT_DIRECT_LANGIUM))]
      }
   },

   // @hydranium/data-server is the typed-RPC head — a peer of glsp-server and
   // of the LSP head at @hydranium/core/lsp. Value imports of the LSP defaults
   // would couple the data-server to the LSP-textual protocol at runtime.
   {
      files: ['packages/data-server/src/**/*.ts'],
      rules: {
         'no-restricted-imports': ['warn', withHost(withNeutral(RESTRICT_HEAD_NEUTRAL))]
      }
   },

   // @hydranium/glsp-server is the GLSP head — same head-neutrality rule.
   {
      files: ['packages/glsp-server/src/**/*.ts'],
      rules: {
         'no-restricted-imports': ['warn', withHost(withNeutral(RESTRICT_HEAD_NEUTRAL))]
      }
   },

   // The GLSP head's browser-only subtree (the `./browser` subpath, holding the
   // worker launcher). It names the upstream browser build by design and stays
   // banned from everything else — `node:*` and a sibling's `/node` above all,
   // since a browser bundle is exactly where those break.
   {
      files: ['packages/glsp-server/src/browser/**/*.ts'],
      rules: {
         'no-restricted-imports': ['warn', withHost(withNeutralExcept(RESTRICT_HEAD_NEUTRAL, RESTRICT_GLSP_BROWSER_BUILD))]
      }
   },

   // @hydranium/protocol is the neutral shared-contract layer (types, constants,
   // transfer model) — node-import-banned like the heads. It never imports
   // langium directly either, so the langium ban rides along as a no-op.
   {
      files: ['packages/protocol/src/**/*.ts'],
      rules: {
         'no-restricted-imports': ['warn', withHost(withNeutral(RESTRICT_DIRECT_LANGIUM))]
      }
   },

   // The host-framework ban, over the WHOLE of each head-neutral package rather
   // than its neutral surfaces alone. `check:neutral` cannot see this one at
   // all: it marks a bare third-party specifier external and then judges the
   // externalised set by name against a Node-only predicate, which `@theia/core`
   // does not satisfy. Whole packages because the argument is about the
   // MANIFEST — one devDependency serves `src/`, `src/node/`, `src/testing/`
   // and `test/` alike, so exempting a tier would leave the host installed for
   // the neutral one anyway. The `src` trees get it through `withHost` in their
   // own blocks; this block covers the `test` trees.
   {
      files: [
         'packages/core/test/**/*.ts',
         'packages/data-server/test/**/*.ts',
         'packages/glsp-server/test/**/*.ts',
         'packages/protocol/test/**/*.ts'
      ],
      rules: {
         'no-restricted-imports': ['warn', withHost(RESTRICT_DIRECT_LANGIUM)]
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
         'no-restricted-imports': ['warn', withHost(RESTRICT_HEAD_NEUTRAL)],
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
   }
];

const base = {
   plugins: ['typescript', 'import'],
   categories: {
      correctness: 'off'
   },
   env: {
      builtin: true,
      es2022: true
   },
   globals: {
      process: 'readonly',
      require: 'readonly',
      module: 'readonly',
      __dirname: 'readonly',
      __filename: 'readonly',
      console: 'readonly',
      Buffer: 'readonly'
   },
   ignorePatterns: ['**/node_modules', '**/lib', '**/dist', '**/out', '**/*.d.ts', '**/generated/**', '**/generated-hydranium/**'],
   rules: {
      'constructor-super': 'error',
      'for-direction': 'error',
      'getter-return': ['error', { allowImplicit: false }],
      'no-async-promise-executor': 'error',
      'no-case-declarations': 'error',
      'no-class-assign': 'error',
      'no-compare-neg-zero': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-const-assign': 'error',
      'no-constant-binary-expression': 'error',
      'no-constant-condition': ['error', { checkLoops: 'allExceptWhileTrue' }],
      'no-control-regex': 'error',
      'no-debugger': 'error',
      'no-delete-var': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-else-if': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-empty-character-class': 'error',
      'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: false }],
      'no-empty-static-block': 'error',
      'no-ex-assign': 'error',
      'no-extra-boolean-cast': ['error', {}],
      'no-fallthrough': ['error', { allowEmptyCase: false, reportUnusedFallthroughComment: false }],
      'no-func-assign': 'error',
      'no-global-assign': ['error', { exceptions: [] }],
      'no-import-assign': 'error',
      'no-invalid-regexp': ['error', {}],
      'no-irregular-whitespace': [
         'error',
         { skipComments: false, skipJSXText: false, skipRegExps: false, skipStrings: true, skipTemplates: false }
      ],
      'no-loss-of-precision': 'error',
      'no-misleading-character-class': ['error', { allowEscape: false }],
      'no-new-native-nonconstructor': 'error',
      'no-nonoctal-decimal-escape': 'error',
      'no-obj-calls': 'error',
      'no-prototype-builtins': 'error',
      'no-redeclare': ['error', { builtinGlobals: true }],
      'no-regex-spaces': 'error',
      'no-self-assign': ['error', { props: true }],
      'no-setter-return': 'error',
      'no-shadow-restricted-names': ['error', { reportGlobalThis: false }],
      'no-sparse-arrays': 'error',
      'no-this-before-super': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': ['error', { enforceForOrderingRelations: false }],
      'no-unsafe-optional-chaining': ['error', { disallowArithmeticOperators: false }],
      'no-unused-labels': 'error',
      'no-unused-private-class-members': 'error',
      'no-unused-vars': [
         'warn',
         {
            argsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            destructuredArrayIgnorePattern: '^_'
         }
      ],
      'no-useless-backreference': 'error',
      'no-useless-catch': 'error',
      'no-useless-escape': ['error', { allowRegexCharacters: [] }],
      'no-with': 'error',
      'require-yield': 'error',
      'use-isnan': ['error', { enforceForIndexOf: false, enforceForSwitchCase: true }],
      'valid-typeof': ['error', { requireStringLiterals: false }],
      'no-array-constructor': 'error',
      'no-unused-expressions': ['error', { allowShortCircuit: false, allowTaggedTemplates: false, allowTernary: false }],
      'import/namespace': 'error',
      'import/default': 'error',
      // Misses two `export *` lines exporting one name; TypeScript reports those.
      'import/export': 'error',
      'import/no-named-as-default': 'warn',
      'import/no-named-as-default-member': 'warn',
      'import/no-duplicates': 'warn',
      'typescript/ban-ts-comment': 'error',
      'typescript/no-duplicate-enum-values': 'error',
      'typescript/no-empty-object-type': 'error',
      'typescript/no-explicit-any': 'warn',
      'typescript/no-extra-non-null-assertion': 'error',
      'typescript/no-misused-new': 'error',
      'typescript/no-non-null-asserted-optional-chain': 'error',
      'typescript/no-require-imports': 'error',
      'typescript/no-this-alias': 'error',
      'typescript/no-unnecessary-type-constraint': 'error',
      'typescript/no-unsafe-declaration-merging': 'error',
      'typescript/no-unsafe-function-type': 'error',
      'typescript/no-wrapper-object-types': 'error',
      'typescript/prefer-as-const': 'error',
      'typescript/prefer-namespace-keyword': 'error',
      'typescript/triple-slash-reference': 'error',
      'typescript/consistent-type-imports': [
         'warn',
         {
            prefer: 'type-imports',
            fixStyle: 'inline-type-imports'
         }
      ],
      'no-undef': ['error', { typeof: false }]
   },
   // Set here rather than as a CLI flag, so no lint invocation that loads this
   // config can omit it and pass a disable comment that suppresses nothing.
   options: {
      reportUnusedDisableDirectives: 'error'
   }
};

module.exports = {
   ...base,
   overrides: [
      {
         files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
         rules: {
            'constructor-super': 'off',
            'getter-return': 'off',
            'no-class-assign': 'off',
            'no-const-assign': 'off',
            'no-dupe-class-members': 'off',
            'no-dupe-keys': 'off',
            'no-func-assign': 'off',
            'no-import-assign': 'off',
            'no-new-native-nonconstructor': 'off',
            'no-obj-calls': 'off',
            'no-redeclare': 'off',
            'no-setter-return': 'off',
            'no-this-before-super': 'off',
            'no-unreachable': 'off',
            'no-unsafe-negation': 'off',
            'no-var': 'error',
            'no-with': 'off',
            'prefer-const': ['error', { destructuring: 'any', ignoreReadBeforeAssign: false }],
            'prefer-rest-params': 'error',
            'prefer-spread': 'error'
         }
      },
      {
         files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
         rules: {
            'no-undef': 'off'
         }
      },
      ...policyOverrides
         .filter(block => block.rules)
         .map(block => ({
            files: block.files ?? ['**/*'],
            ...(block.ignores ? { excludeFiles: block.ignores } : {}),
            rules: block.rules
         }))
   ]
};
