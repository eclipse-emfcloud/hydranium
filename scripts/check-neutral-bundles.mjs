/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Neutrality gate: the `.` entry of each head — plus the example client's data
// tier, which a VS Code webview loads — must bundle for the browser with no
// `node:*` builtin imports, including TRANSITIVE ones a barrel might pull in
// (which the eslint `node:*` ban, being per-file, cannot see). Catches a
// regression like a portable barrel re-exporting a `src/node/` module.
//
// Bundles each package's built `lib/index.js` with esbuild `platform: 'browser'`.
// THIRD-PARTY bare deps are externalised, so an unrelated package's Node code
// does not decide our verdict — except the ones a package is meant to
// browser-resolve (glsp-server lets `@eclipse-glsp/server` resolve so its
// package.json `browser` field swap to the node-free build is exercised; a
// re-introduced `/node` pin would then surface as a `node:` error).
// `@hydranium/*` is never externalised: see `neutralityFailures`, which also
// judges an externalised bare specifier by NAME (`isNodeOnlySpecifier`), since
// nothing looks inside one.
// Run after a build (`lib/` must exist); wired into `check`.
//
// DOM-freedom is a SEPARATE and NARROWER claim, and this gate does not test it:
// it comes from `lib: ["ES2022"]` (no DOM) in tsconfig.base.json, so it holds
// only for the gated entries whose package inherits that `lib`. A Theia-host
// package whose `./browser` tier genuinely renders raises the grant
// package-wide, which lifts the ban off its neutral entries too — so the DOM
// half is reported per entry from the tsconfigs (`domBannedFor`) rather than
// claimed for all of them.

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The workspace directory a gated entry belongs to, cut at the `lib/` the entry
 * is built into. Not a fixed path depth: an example package sits one level
 * deeper than a framework one (`examples/order-flow/client` vs
 * `packages/core`), so counting segments would name the example DIRECTORY and
 * read a tsconfig that governs nothing.
 */
function packageOf(entry) {
   const segments = entry.split('/');
   return segments.slice(0, segments.indexOf('lib')).join('/');
}

/**
 * Whether DOM globals are compile-errors in a package, read from its tsconfig
 * rather than assumed from the base. Absent `lib` means it inherits
 * `tsconfig.base.json`'s DOM-free one; present `lib` decides on its own.
 * `JSON.parse` is safe because no package tsconfig carries comments — a `lib`
 * naming DOM would otherwise be reported as banned, which is the direction that
 * lies.
 */
function domBannedFor(pkg) {
   const tsconfig = JSON.parse(readFileSync(resolve(repoRoot, pkg, 'tsconfig.json'), 'utf8'));
   const lib = tsconfig.compilerOptions?.lib;
   return lib === undefined || !lib.some(entry => /^dom(\.|$)/i.test(entry));
}

/** Neutral `.` entries, with packages to actually resolve (vs externalise). */
const TARGETS = [
   { name: '@hydranium/protocol', entry: 'packages/protocol/lib/index.js', resolvePackages: [] },
   { name: '@hydranium/core', entry: 'packages/core/lib/index.js', resolvePackages: [] },

   // The pinned-Langium chokepoint. `langium` is RESOLVED rather than
   // externalised, because the regression worth catching here is this package's
   // own `index.ts` or `lsp.ts` re-exporting its `./node` tier: externalising
   // `langium` would externalise `langium/node` with it and the probe would see
   // no builtin. The `node:*` and `@hydranium/*/node` import bans are scoped to
   // the head packages, so lint does not cover this one either.
   { name: '@hydranium/langium', entry: 'packages/langium/lib/index.js', resolvePackages: ['langium'] },
   { name: '@hydranium/langium (./lsp)', entry: 'packages/langium/lib/lsp.js', resolvePackages: ['langium'] },

   { name: '@hydranium/data-server', entry: 'packages/data-server/lib/index.js', resolvePackages: [] },
   { name: '@hydranium/glsp-server', entry: 'packages/glsp-server/lib/index.js', resolvePackages: ['@eclipse-glsp/server'] },

   // The worker launcher. Browser-ONLY rather than neutral, so "no node:*" is
   // not a portability claim here — it is the entry's whole contract, and the
   // one thing that would break it is reaching a Node-side sibling for a
   // convenience. It resolves `@eclipse-glsp/server` for the same reason the
   // `.` entry does: the subpath it names is the upstream BROWSER build, and a
   // slip back to `/node` has to surface as a `node:` error rather than as an
   // externalised bare specifier nobody looked inside.
   {
      name: '@hydranium/glsp-server (./browser)',
      entry: 'packages/glsp-server/lib/browser/index.js',
      resolvePackages: ['@eclipse-glsp/server']
   },

   // The host-neutral client tier. Covered transitively by the `.` entry above
   // (the root barrel re-exports `./client`), but named separately so a
   // regression reports against the client tier rather than against the whole
   // package. This is what a VS Code WEBVIEW loads, where the sandbox is a
   // browser with no `net` and no Node builtins, so a `node:*` import here
   // breaks the form rather than merely bloating it.
   { name: '@hydranium/protocol (./client)', entry: 'packages/protocol/lib/client/index.js', resolvePackages: [] },

   // `./data` for the same reason as `./client` above: a webview loads it.
   { name: '@hydranium/protocol (./data)', entry: 'packages/protocol/lib/data/index.js', resolvePackages: [] },

   // The message barrels, one per identity-side package. Gated rather than
   // excused, and a webview is exactly the caller: the render happens on the side
   // that knows the reading user's locale, so a form editor imports the barrel to
   // map a code onto its own translation. Neutral by content today — declarations
   // plus type-only carrier imports — which is the state a gate exists to keep.
   { name: '@hydranium/protocol (./messages)', entry: 'packages/protocol/lib/messages/index.js', resolvePackages: [] },
   { name: '@hydranium/core (./messages)', entry: 'packages/core/lib/messages/index.js', resolvePackages: [] },
   { name: '@hydranium/data-server (./messages)', entry: 'packages/data-server/lib/messages/index.js', resolvePackages: [] },
   {
      name: '@hydranium/glsp-server (./messages)',
      entry: 'packages/glsp-server/lib/messages/index.js',
      resolvePackages: ['@eclipse-glsp/server']
   },

   // The LSP head. Already covered transitively — `@hydranium/data-server`'s
   // gated `.` entry imports it — but named separately so a regression reports
   // against the LSP tier instead of against the data head, and because an
   // adopter's language module imports it directly on the way into a worker.
   { name: '@hydranium/core (./lsp)', entry: 'packages/core/lib/lsp/index.js', resolvePackages: [] },

   // The Theia client packages. A Theia frontend IS a browser, so `node:*` here
   // breaks the form rather than merely bloating it — the same argument the
   // webview entries make. Each `.` and `./browser` pair is listed because the
   // `./node` siblings are where anything Node-only belongs, and nothing was
   // stopping a slip in the other direction: all of these were neutral purely by
   // content when they were first checked, with no gate to keep them that way.
   { name: '@hydranium/client-theia', entry: 'packages/client-theia/lib/index.js', resolvePackages: [] },
   { name: '@hydranium/client-theia (./browser)', entry: 'packages/client-theia/lib/browser/index.js', resolvePackages: [] },
   { name: '@hydranium/glsp-client-theia', entry: 'packages/glsp-client-theia/lib/index.js', resolvePackages: [] },
   {
      name: '@hydranium/glsp-client-theia (./browser)',
      entry: 'packages/glsp-client-theia/lib/browser/index.js',
      resolvePackages: []
   },
   { name: '@hydranium/data-client-theia', entry: 'packages/data-client-theia/lib/index.js', resolvePackages: [] },
   { name: '@hydranium/data-client-theia (./common)', entry: 'packages/data-client-theia/lib/common/index.js', resolvePackages: [] },
   {
      name: '@hydranium/data-client-theia (./browser)',
      entry: 'packages/data-client-theia/lib/browser/index.js',
      resolvePackages: []
   },

   // The portable half of the test-support surface, so a browser-hosted test
   // tier can load the doubles. Worth saying why these are listed at all:
   // before this block they were neutral by luck rather than by design — some
   // happened to contain no Node code, while others were tainted by ONE module
   // (`protocol/testing`'s duplex transports) they had no other Node dependency
   // on, and nothing reported either fact. The runtime-bound halves moved behind
   // `./testing/node`, which is deliberately NOT gated.
   //
   // The non-`/node` public subpaths this list OMITS are enumerated in
   // `NOT_GATED` below, each with the reason it is excluded on its merits.
   { name: '@hydranium/protocol (./testing)', entry: 'packages/protocol/lib/testing/index.js', resolvePackages: [] },
   { name: '@hydranium/core (./testing)', entry: 'packages/core/lib/testing/index.js', resolvePackages: [] },
   {
      name: '@hydranium/glsp-server (./testing)',
      entry: 'packages/glsp-server/lib/testing/index.js',
      resolvePackages: ['@eclipse-glsp/server']
   },
   { name: '@hydranium/client-theia (./testing)', entry: 'packages/client-theia/lib/testing/index.js', resolvePackages: [] },
   {
      name: '@hydranium/glsp-client-theia (./testing)',
      entry: 'packages/glsp-client-theia/lib/testing/index.js',
      resolvePackages: []
   },
   { name: '@hydranium/conformance', entry: 'packages/conformance/lib/index.js', resolvePackages: [] },

   // The example's remaining client-side modules, gated module-by-module rather
   // than through its barrel — the barrel also re-exports the diagram
   // definition, whose `@eclipse-glsp/client` graph reaches CSS imports and
   // needs a bundler with a loader for them.
   //
   // Still gated here even though `examples/order-flow/vscode`'s webview bundle
   // now consumes both modules, because the two checks fail differently and the
   // difference is useful. That bundle IS a neutrality gate — esbuild with
   // `platform: 'browser'` refuses to resolve a `node:*` builtin rather than
   // shimming it, so a Node import anywhere in the webview graph fails
   // `order-flow-vscode`'s build. But it reports against the whole graph, and
   // only for the modules that bundle reaches. These two entries keep the blame
   // on the client tier and keep covering it if the webview stops importing it.
   {
      name: 'order-flow-client (properties model)',
      entry: 'examples/order-flow/client/lib/data/order-flow-properties-model.js',
      resolvePackages: []
   },
   {
      name: 'order-flow-client (messenger channel)',
      entry: 'examples/order-flow/client/lib/data/order-flow-messenger-channel.js',
      resolvePackages: []
   }
];

/**
 * The public subpaths deliberately NOT gated above, and why each one is a
 * decision rather than an oversight.
 *
 * This is DATA rather than prose because `check:glob-coverage` reads it: that
 * gate asserts every non-`/node` `exports` key across `packages/*` is named
 * either in `TARGETS` or here, so a new subpath forces the question instead of
 * defaulting to ungated. The only thing separating a considered exclusion from
 * an omission is being written down, and an omission reads as neither.
 *
 * `/node` subpaths are out of scope there by the framework's own server-only
 * boundary, not by an entry-level judgement, so they are not listed here.
 */
const NOT_GATED = [
   {
      entry: 'packages/data-server/lib/testing/index.js',
      why: 'a single harness over a duplex `MessageConnection` — there is no portable half to protect, so splitting it would leave an empty barrel'
   },
   {
      entry: 'packages/conformance/lib/data/index.js',
      why: 'a head slice that asserts with `node:assert/strict` by deliberate design, the kit importing no runner'
   },
   {
      entry: 'packages/conformance/lib/lsp/index.js',
      why: 'a head slice that asserts with `node:assert/strict` by deliberate design, the kit importing no runner'
   },
   {
      entry: 'packages/conformance/lib/glsp/index.js',
      why: 'a head slice that asserts with `node:assert/strict` by deliberate design, the kit importing no runner'
   },
   {
      entry: 'packages/conformance/lib/vitest/index.js',
      why: 'a runner adapter that re-exports the head slices rather than asserting itself, so it inherits their `node:assert` dependency'
   },
   {
      entry: 'packages/conformance/lib/jest/index.js',
      why: 'a runner adapter that re-exports the head slices rather than asserting itself, so it inherits their `node:assert` dependency'
   },
   {
      entry: 'packages/langium/lib/test.js',
      why: 'a passthrough of upstream `langium/test`, which imports `node:assert` — neutrality here is not ours to grant'
   },
   {
      entry: 'packages/core/lib/testing/playwright/index.js',
      why: 'drives a Playwright runner that reads and renames server log files, so it is Node-bound at its purpose rather than incidentally'
   },
   {
      entry: 'packages/cli/lib/index.js',
      why: 'the CLI is a Node tool by definition — it spawns child processes and reads the filesystem, and no host loads it in a browser'
   },
   {
      entry: 'packages/cli/lib/cli.js',
      why: 'the CLI binary itself, reached by specifier so a consumer can spawn it; Node-only for the same reason as the barrel above'
   },
   {
      entry: 'packages/glsp-client-theia/style/diagram-loading.css',
      why: 'a stylesheet, not a module — there is no import graph to bundle and `check:exports` asserts its existence and shipping instead'
   }
];

const NODE_BUILTINS = new Set(builtinModules);

/**
 * True for a bare specifier that only resolves on Node: a builtin spelled
 * WITHOUT the `node:` prefix (`'path'`, `'fs'`), or a package's `/node` subpath
 * (`vscode-jsonrpc/node`).
 *
 * Both are invisible to the `node:` error check below, because externalising a
 * bare specifier means esbuild never looks inside it — so it resolves fine at
 * bundle time and fails in a browser at runtime, which is the worse order.
 */
function isNodeOnlySpecifier(specifier) {
   return NODE_BUILTINS.has(specifier) || specifier === 'node' || specifier.endsWith('/node') || specifier.includes('/node/');
}

/**
 * The one Node-only specifier a gated entry may reach, keyed by importer so a
 * SECOND bare `'path'` elsewhere still fails. Deliberate: the workspace
 * initializer spells it bare precisely so a browser bundle can alias it to a
 * POSIX shim — a bundler's alias map keys on the specifier string, and the
 * `node:` spelling must stay unaliased so that at `platform: 'browser'` esbuild
 * still refuses to resolve a genuine Node builtin rather than shimming it. The
 * bare import is reached only by the headless seam that takes filesystem-path
 * strings, so a browser host never runs it.
 */
const ALLOWED_NODE_SPECIFIERS = [{ specifier: 'path', importer: 'packages/core/lib/langium/workspace/initialize-workspace.js' }];

/**
 * An absolute importer path as the allowlist above writes it: repo-relative,
 * `/`-separated on every platform.
 *
 * Stripping the root by `replace(repoRoot + '/', …)` instead would leave a
 * Windows path untouched — the separators disagree — so the absolute path would
 * be compared against a relative allowlist entry, match nothing, and report the
 * one deliberate bare `'path'` import as a violation.
 */
function repoRelative(absolutePath) {
   return relative(repoRoot, absolutePath).split(sep).join('/');
}

/**
 * The importers of `specifier` that no allowlist entry covers. Reported instead
 * of the whole importer set so an allowed importer is never named beside an
 * offending one — the deliberate bare `'path'` would otherwise appear in the
 * failure text and read as the thing to fix.
 */
function offendingImporters(specifier, importers) {
   return [...importers].filter(
      importer => !ALLOWED_NODE_SPECIFIERS.some(allowed => allowed.specifier === specifier && allowed.importer === importer)
   );
}

/**
 * Bundle one entry for the browser; return the reasons it is not neutral (empty
 * = neutral). Two independent checks, because they fail differently:
 *
 * - a `node:` import errors during resolution, so esbuild reports it;
 * - a Node-only BARE specifier does not, because it is externalised unread.
 *
 * `@hydranium/*` is ALWAYS resolved, never externalised. Externalising it would
 * scope the check to each package's own files, and the failure that actually
 * happens is at a package boundary: a portable entry importing a SIBLING's
 * `/node` subpath is invisible to a per-package check, passes the gate, and then
 * cannot be bundled by any adopter. Measured — `@hydranium/data-server` reached
 * `node:fs`, `node:v8` and `node:perf_hooks` through `@hydranium/core/node`
 * while this gate reported it neutral.
 *
 * THIRD-PARTY bare deps stay externalised, so an unrelated package's Node code
 * does not decide our verdict — but that is exactly what hid `vscode-jsonrpc/node`
 * inside the duplex test transport until the `./testing/node` split moved it out
 * of every gated entry. Hence `isNodeOnlySpecifier`: judge the specifier by name
 * when its contents are not being read.
 */
async function neutralityFailures(entry, resolvePackages) {
   const shouldResolve = path => path.startsWith('@hydranium/') || resolvePackages.some(pkg => path === pkg || path.startsWith(pkg + '/'));
   const externalised = new Map();
   const result = await build({
      entryPoints: [resolve(repoRoot, entry)],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
      plugins: [
         {
            name: 'externalise-bare',
            setup(builder) {
               builder.onResolve({ filter: /^[^./]/ }, args => {
                  // The filter means "bare specifier", and it expresses that as
                  // "starts with neither `.` nor `/`" — which is true of a
                  // WINDOWS absolute path, since that begins with a drive
                  // letter. The entry point itself arrives here as an absolute
                  // path, so on Windows it matched, fell through to the
                  // externalise below, and left an empty bundle: no imports
                  // read, no errors raised, every entry reported neutral while
                  // nothing was inspected. A POSIX entry starts with `/` and
                  // never matched, so the gate was blind on one platform only.
                  if (args.kind === 'entry-point' || isAbsolute(args.path)) {
                     return undefined;
                  }
                  if (args.path.startsWith('node:')) {
                     return undefined; // let node: builtins fail loudly
                  }
                  if (shouldResolve(args.path)) {
                     return undefined; // resolve it (exercise its browser field)
                  }
                  if (isNodeOnlySpecifier(args.path)) {
                     const importers = externalised.get(args.path) ?? new Set();
                     importers.add(repoRelative(args.importer));
                     externalised.set(args.path, importers);
                  }
                  return { path: args.path, external: true };
               });
            }
         }
      ]
   }).catch(error => ({ errors: error.errors ?? [{ text: String(error) }] }));

   const failures = (result.errors ?? []).filter(error => /node:/.test(error.text)).map(error => error.text);
   for (const [specifier, importers] of externalised) {
      const offenders = offendingImporters(specifier, importers);
      if (offenders.length > 0) {
         failures.push(`Node-only bare specifier "${specifier}" imported by ${offenders.join(', ')}`);
      }
   }
   return failures;
}

/**
 * Fixtures that MUST be rejected. Every check here is a REGRESSION gate: the
 * repo is neutral today, so a clean run is the expected outcome and therefore
 * carries no information about whether the checks still fire. A gate whose
 * detection silently stopped matching looks exactly like a gate with nothing to
 * find — these make the two distinguishable on every run.
 *
 * One canary per detection path, because they fail through different code: a
 * `node:` specifier via an esbuild resolution error, and the two bare forms via
 * `isNodeOnlySpecifier`, which is the only thing that sees them.
 */
const CANARIES = [
   { name: '`node:`-prefixed builtin', entry: 'scripts/fixtures/neutrality-canary/node-prefixed-builtin.mjs' },
   { name: 'bare builtin from an unlisted importer', entry: 'scripts/fixtures/neutrality-canary/bare-builtin.mjs' },
   { name: 'third-party `/node` subpath', entry: 'scripts/fixtures/neutrality-canary/third-party-node-subpath.mjs' }
];

let failed = false;

for (const canary of CANARIES) {
   const failures = await neutralityFailures(canary.entry, []);
   if (failures.length === 0) {
      failed = true;
      console.error(`✗ SELF-TEST FAILED: the ${canary.name} canary was NOT rejected — this gate has gone blind`);
   } else {
      console.log(`✓ self-test: ${canary.name} rejected as it must be`);
   }
}
console.log('');

for (const target of TARGETS) {
   const failures = await neutralityFailures(target.entry, target.resolvePackages);
   if (failures.length > 0) {
      failed = true;
      console.error(`✗ ${target.name} is not neutral — ${failures.length} Node dependency(ies) break the browser:`);
      for (const failure of failures) {
         console.error(`    ${failure}`);
      }
   } else {
      console.log(`✓ ${target.name} is neutral — runs in Node and the browser (no node: imports)`);
   }
}

if (failed) {
   console.error('\nNeutrality gate failed: move node-only code behind the `./node` subpath.');
   console.error('(A SELF-TEST failure means the opposite — the gate stopped detecting, so fix the gate.)');
   process.exit(1);
}
// This gate checks the browser direction (no node:* imports) for every entry.
// The Node direction (no DOM globals) is compile-enforced elsewhere and does not
// cover all of them, so it is derived and named rather than asserted — an
// enumeration written here would read as universal the moment a package changed
// its `lib`.
const domGranted = [...new Set(TARGETS.map(target => packageOf(target.entry)))].filter(pkg => !domBannedFor(pkg));
console.log(`\nEvery one of the ${TARGETS.length} gated entries is neutral in the direction this gate tests: no node: imports.`);
if (domGranted.length === 0) {
   console.log('DOM is compile-banned for all of them (every package inherits `lib: ["ES2022"]`).');
} else {
   const exempt = TARGETS.filter(target => domGranted.includes(packageOf(target.entry)));
   console.log(
      `DOM is compile-banned for ${TARGETS.length - exempt.length} of them. NOT for the ${exempt.length} entries of ` +
         `${domGranted.join(', ')}, each of which raises \`lib\` package-wide because one of its tiers renders.`
   );
}
console.log(
   `(${NOT_GATED.length} further public subpaths are excluded by name in NOT_GATED; check:glob-coverage holds both lists complete.)`
);
