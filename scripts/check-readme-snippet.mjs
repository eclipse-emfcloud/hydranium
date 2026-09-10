/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// README-snippet gate: every ```ts fence in each README named by SNIPPET_TARGETS
// must typecheck against the built packages. A copy-pasted snippet is the first
// thing a new adopter runs, and it rots silently — API renames don't touch
// markdown, so only compiling the snippet catches the drift. Gating the root
// README alone is not enough: an example README's fence referenced a type
// exported from a test helper and unreachable from the package's public surface,
// and nothing caught it. A named list would only narrow that hole, so a
// discovery pass fails any tracked README holding a fence no target compiles.
//
// Each fence is written to a temp `.mts` file inside its target's host package,
// so `@hydranium/*` resolve through the workspace and the host's own devDeps are
// reachable, and typechecked with `tsc --strict`. `.mts` (not `.ts`) makes the
// temp file ESM whatever the host package's `"type"` says, which is what lets a
// fence use top-level await without constraining the host choice.
//
// The fences are compiled ONE PROCESS PER HOST, not one per fence. A `tsc` boot
// costs about three quarters of a second before it reads a line of the snippet,
// which dominates this gate; several targets share a host, so grouping turns
// seventeen processes into four. Grouping is safe because `.mts` is
// unconditionally a module, so snippets sharing a program share no scope — and
// it is grouped by HOST rather than by README because the host package is what
// decides resolution.
//
// A fence is documentation first. It may therefore omit the imports and the
// ambient bindings that would bury the three lines it exists to show, and
// declare them in an adjacent `<!-- snippet-preamble ... -->` comment instead:
// hidden from the rendered page, prepended by this gate, and located next to the
// fence so an author editing one sees the other. Reported error lines are
// translated back to real README lines, so the preamble costs the reader nothing.
//
// Run after a build (`lib/` must exist); wired into `check`.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The gated READMEs.
 *
 * `host` is the package the fence is compiled inside: it decides which
 * `node_modules` and which relative paths the snippet can reach, so it must be a
 * package that genuinely depends on everything the fence names. It does NOT
 * decide the module system — the temp file is `.mts`, so a CommonJS host hosts
 * an ESM snippet fine.
 *
 * `rewrites` map an illustrative import path to where the real file lives
 * relative to the temp-file directory (one level below the host package). They
 * exist so a fence can show the path an adopter will write rather than the path
 * that happens to resolve in this repo.
 */
const SNIPPET_TARGETS = [
   {
      readme: 'README.md',
      host: 'examples/order-flow/server',
      rewrites: [{ from: "'./generated/", to: "'../src/language-server/generated/" }]
   },
   {
      readme: 'examples/order-flow/client/README.md',
      host: 'examples/order-flow/client'
   },
   {
      readme: 'packages/protocol/src/rpc/README.md',
      host: 'packages/protocol'
   },
   {
      readme: 'packages/protocol/README.md',
      host: 'packages/protocol'
   },
   {
      readme: 'docs/contributing/conventions.md',
      host: 'examples/order-flow/server',
      // Illustrative stand-ins the prose names but never defines. Real
      // framework symbols are imported by the fences themselves, so that a
      // rename still breaks the gate; only the invented ones live here.
      preamble: [
         "import type { ServerSharedServices } from '@hydranium/core';",
         // The prose is loose about which tree `services` names, so the
         // stand-in satisfies both the shared-tree and the `.shared` spellings.
         'declare const services: ServerSharedServices & { readonly shared: ServerSharedServices };',
         'declare function makeTestServices(config: {',
         '   languages: readonly { languageId: string; fileExtensions: string[]; producedTypes: string[] }[];',
         '}): MyServices;',
         'declare class MyServices {}'
      ].join('\n')
   },
   // Every fence here is a skip, so nothing compiles — the entry exists because
   // discovery requires one, and it will start earning its keep the moment a
   // compilable fence is added.
   { readme: 'docs/concepts/scope-and-visibility.md', host: 'examples/order-flow/server' },
   {
      readme: 'docs/concepts/contributions.md',
      host: 'examples/order-flow/server',
      preamble: [
         "import type { AstNode } from 'langium';",
         "import { HydraniumDocumentValidator } from '@hydranium/core';",
         'import type {',
         '   HydraniumAstNodeDescriptionProvider,',
         '   IntegrityRule,',
         '   IntegrityRuleContribution,',
         '   IntegrityRuleRegistry,',
         '   ServerSharedServices',
         "} from '@hydranium/core';",
         'type Root = AstNode & { name: string; elements: Element[] };',
         'type Element = AstNode & { name: string };',
         'declare const ElementMeta: { $type: string };',
         'declare const RootMeta: { $type: string };',
         'declare const stdlibElements: readonly Element[];',
         'declare function isDeprecated(node: AstNode): boolean;',
         'declare const ElementNameUniquenessRule: new () => IntegrityRule<AstNode>;',
         'declare const ElementTypeRule: new () => IntegrityRule<AstNode>;',
         // The prose is loose about which tree `services` names, so the
         // stand-in satisfies both the shared-tree and the `.shared` spellings.
         'declare const services: ServerSharedServices & { readonly shared: ServerSharedServices };',
         'declare const provider: HydraniumAstNodeDescriptionProvider;',
         'declare const node: Element;',
         'declare const description: { documentUri: string };'
      ].join('\n')
   },
   { readme: 'docs/concepts/framework-vs-adopter.md', host: 'examples/order-flow/server' },
   // Hosted by the BROWSER example, not the server one: its fence names
   // `@hydranium/glsp-server/browser`, and only a package that declares the
   // dependency should be able to reach it. The fence's own preamble supplies
   // the transferred port, which has no name under this gate's DOM-free lib.
   { readme: 'docs/concepts/browser-hosting.md', host: 'examples/order-flow/browser' },
   {
      readme: 'docs/concepts/document-layers.md',
      host: 'examples/order-flow/server',
      preamble: [
         "import type { AstNode } from 'langium';",
         "import type { AstDocument } from '@hydranium/core';",
         "import type { TransferDocument, TransferElement } from '@hydranium/protocol';",
         'type MyRoot = AstNode;',
         'type MyTransferRoot = TransferElement;',
         'declare class MyDiagnostic {}'
      ].join('\n')
   },
   {
      readme: 'docs/concepts/shared-vs-language-di-scope.md',
      host: 'examples/order-flow/server',
      preamble: [
         "import { inject } from 'langium';",
         "import { createDefaultModule, createDefaultSharedModule } from 'langium/lsp';",
         "import { createServerLanguageModule, createServerSharedModule } from '@hydranium/core';",
         "import { createLspServerLanguageModule, createLspServerSharedModule } from '@hydranium/core/lsp';",
         "import type { ServerModuleContext } from '@hydranium/core';",
         'declare const ctx: ServerModuleContext;',
         'declare const MyGrammarGeneratedSharedModule: never;',
         'declare const MyGrammarGeneratedModule: never;',
         'declare const MyAddedSharedModule: never;',
         'declare const MyAddedLanguageModule: never;'
      ].join('\n')
   }
];

/**
 * Files the discovery pass holds to the list above. A named-target list is
 * opt-in, so on its own it only moves the hole rather than closing it: the next
 * README to grow a fence is ungated exactly the way every example README was.
 * Discovery makes that a build failure instead of a silence.
 *
 * Covers the READMEs and the LIVE docs. The dated design snapshots are
 * deliberately out: their fences describe the API as it was, so compiling them
 * would force rewriting history to keep a gate green. They are also excluded
 * from the public tree, so nothing here has to name their location.
 */
const DISCOVERY_PATHSPECS = ['*README.md', 'docs/adopting/*.md', 'docs/concepts/*.md', 'docs/contributing/*.md'];

const TSC_FLAGS = [
   '--noEmit',
   '--strict',
   '--module',
   'nodenext',
   '--moduleResolution',
   'nodenext',
   '--target',
   'es2022',
   '--skipLibCheck'
];

const FENCE_PATTERN = /^```ts\n([\s\S]*?)^```$/gm;
/** A preamble block, anchored to the end of the text preceding its fence. */
// `(?!-->)` keeps the body from running past an earlier block's terminator: a
// file with two preambles would otherwise match from the FIRST one and swallow
// every fence between them.
const PREAMBLE_PATTERN = /<!--\s*snippet-preamble\n((?:(?!-->)[\s\S])*?)\n-->$/;
/**
 * Opt-out for a fence that is deliberately not a compilable program — an
 * elided `{ ... }` body, a bare signature, a Yes/No pair. The reason is
 * mandatory: without it this degrades into a way to silence a real break, and
 * the whole point of the gate is that silence is what let the fences rot.
 */
const SKIP_PATTERN = /<!--\s*snippet-skip:\s*(.+?)\s*-->$/;

/**
 * Extract all ```ts fenced blocks with their 1-based README start line and the
 * preamble that immediately precedes them, if any.
 */
function extractTsFences(markdown) {
   const fences = [];
   FENCE_PATTERN.lastIndex = 0;
   for (let match = FENCE_PATTERN.exec(markdown); match !== null; match = FENCE_PATTERN.exec(markdown)) {
      const before = markdown.slice(0, match.index);
      const trimmed = before.trimEnd();
      fences.push({
         line: before.split('\n').length,
         code: match[1],
         preamble: PREAMBLE_PATTERN.exec(trimmed)?.[1] ?? '',
         skip: SKIP_PATTERN.exec(trimmed)?.[1] ?? ''
      });
   }
   return fences;
}

/**
 * Rewrite `snippet.mts(line,col)` positions in tsc's output into real README
 * positions, undoing both the prepended preamble and the fence's offset in the
 * file. Without this the reported line is a temp-file line and points at nothing
 * the reader can open.
 */
function reportAt(tscOutput, tempFileName, readme, fenceLine, preambleLineCount) {
   // tsc reports the temp file by a path relative to ITS cwd, not ours, so the
   // leading directories have to be swallowed by the match rather than stripped.
   const pattern = new RegExp(`[^\\s(]*${tempFileName}\\((\\d+),(\\d+)\\)`, 'g');
   return tscOutput.replaceAll(pattern, (_whole, line, column) => {
      const codeLine = Number(line) - preambleLineCount;
      // A position inside the preamble has no README line to name.
      return codeLine < 1 ? `${readme} (snippet-preamble line ${line}, col ${column})` : `${readme}:${fenceLine + codeLine}:${column}`;
   });
}

const tscBin = resolve(repoRoot, 'node_modules/typescript/bin/tsc');
let failed = false;
let checked = 0;
let withPreamble = 0;
let skipped = 0;

// Discovery: every tracked README carrying a ```ts fence must be a named
// target. `git ls-files` rather than a filesystem walk, so build output and
// `node_modules` copies of our own READMEs cannot enter the sweep.
const tracked = spawnSync('git', ['-C', repoRoot, 'ls-files', ...DISCOVERY_PATHSPECS], { encoding: 'utf8' });
if (tracked.status !== 0) {
   console.error(`✗ Could not list tracked docs: ${(tracked.stderr ?? '').trim()}`);
   process.exit(1);
}
const named = new Set(SNIPPET_TARGETS.map(target => target.readme));
const swept = tracked.stdout.split('\n').filter(Boolean);
// An empty sweep would pass silently and look identical to a clean one, so the
// count is reported rather than assumed.
if (swept.length < SNIPPET_TARGETS.length) {
   console.error(
      `✗ Discovery swept ${swept.length} file(s), fewer than the ${SNIPPET_TARGETS.length} named targets — the pathspecs are wrong.`
   );
   process.exit(1);
}
for (const file of swept) {
   if (named.has(file)) {
      continue;
   }
   if (extractTsFences(readFileSync(resolve(repoRoot, file), 'utf8')).length > 0) {
      console.error(
         `✗ ${file} has a \`\`\`ts fence but is not in SNIPPET_TARGETS, so nothing compiles it. Add a target (pick a \`host\` package that depends on what the fence names).`
      );
      failed = true;
   }
}

/** Compilable snippets, keyed by the host package whose `tsc` run will hold them. */
const byHost = new Map();

SNIPPET_TARGETS.forEach((target, targetIndex) => {
   const readmePath = resolve(repoRoot, target.readme);
   const fences = extractTsFences(readFileSync(readmePath, 'utf8'));
   if (fences.length === 0) {
      console.error(`✗ No \`\`\`ts fences found in ${target.readme} — the extraction regex changed, or this target is stale config.`);
      failed = true;
      return;
   }

   for (const fence of fences) {
      if (fence.skip) {
         console.log(`− ${target.readme} ts fence (line ${fence.line}) skipped: ${fence.skip}`);
         skipped++;
         continue;
      }
      // `--` closes an HTML comment, so a preamble containing one would leak
      // into the rendered page — a rendering bug this gate would not see.
      if (fence.preamble.includes('--')) {
         console.error(`✗ ${target.readme}:${fence.line} — the snippet-preamble contains \`--\`, which terminates the HTML comment early.`);
         failed = true;
         continue;
      }
      if (fence.preamble) {
         withPreamble++;
      }

      let code = fence.code;
      for (const rewrite of target.rewrites ?? []) {
         code = code.replaceAll(rewrite.from, rewrite.to);
      }
      // The target's own preamble comes first, so a doc whose fences share a
      // set of imports declares them once instead of per fence.
      const preamble = [target.preamble ?? '', fence.preamble].filter(Boolean).join('\n');
      const entries = byHost.get(target.host) ?? [];
      entries.push({
         readme: target.readme,
         line: fence.line,
         preambleLineCount: preamble ? preamble.split('\n').length : 0,
         // The target index is what keeps two READMEs sharing a host from
         // colliding when both carry a fence on the same line — one file would
         // silently overwrite the other and the gate would compile it twice.
         tempFileName: `snippet-${targetIndex}-line-${fence.line}.mts`,
         contents: preamble ? `${preamble}\n${code}` : code
      });
      byHost.set(target.host, entries);
   }
});

for (const [host, entries] of byHost) {
   const tempDir = mkdtempSync(join(resolve(repoRoot, host), '.readme-snippet-'));
   try {
      const tempFiles = entries.map(entry => {
         const tempFile = join(tempDir, entry.tempFileName);
         writeFileSync(tempFile, entry.contents);
         return tempFile;
      });

      const result = spawnSync(process.execPath, [tscBin, ...TSC_FLAGS, ...tempFiles], { encoding: 'utf8' });
      checked += entries.length;
      if (result.status === 0) {
         for (const entry of entries) {
            console.log(`✓ ${entry.readme} ts fence (line ${entry.line}) typechecks`);
         }
         continue;
      }

      failed = true;
      let output = (result.stdout + result.stderr).trim();
      // Which fences the diagnostics actually name, read BEFORE the rewrite
      // below replaces those names. One broken fence must not report its
      // siblings as broken: they share a process, not a verdict.
      const blamed = new Set(entries.filter(entry => output.includes(entry.tempFileName)).map(entry => entry.tempFileName));
      if (blamed.size === 0) {
         // tsc failed over a set of files and blamed none of them, so the fault
         // is the invocation rather than any snippet — a bad flag, or a host
         // package that no longer resolves what its targets name.
         console.error(`✗ ${host}: tsc failed without naming a snippet, so the flags or the host package are wrong:`);
      } else {
         for (const entry of entries) {
            if (blamed.has(entry.tempFileName)) {
               console.error(`✗ ${entry.readme} ts fence (line ${entry.line}) does not typecheck:`);
            } else {
               console.log(`✓ ${entry.readme} ts fence (line ${entry.line}) typechecks`);
            }
         }
      }
      for (const entry of entries) {
         output = reportAt(output, entry.tempFileName, entry.readme, entry.line, entry.preambleLineCount);
      }
      console.error(output);
   } finally {
      rmSync(tempDir, { recursive: true, force: true });
   }
}

if (failed) {
   console.error(
      '\nREADME-snippet gate failed. For a fence that no longer matches the API: update it, or, if a name is simply not imported by the fence, declare it in a `<!-- snippet-preamble ... -->` comment directly above it. For an ungated fence: add its README to SNIPPET_TARGETS.'
   );
   process.exit(1);
}
console.log(
   `\nAll ${checked} ts fence(s) across ${SNIPPET_TARGETS.length} file(s) compile against the current API (${withPreamble} with a preamble, ${skipped} skipped as non-compilable fragments); ${swept.length} tracked docs swept for ungated fences.`
);
