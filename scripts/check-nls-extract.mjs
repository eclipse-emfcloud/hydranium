#!/usr/bin/env node
/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Host-catalogue gate: every `nls.localize` key in the framework's own sources
 * must survive extraction.
 *
 * The host-bound keys are inline literals with no barrel to enumerate, so
 * `theia nls-extract` is the only way to list them — and it SUPPRESSES its own
 * diagnostics. A key it cannot place is dropped from the catalogue and the
 * command still exits 0, so an adopter generating a translation template gets a
 * short catalogue with nothing anywhere reporting it. The shapes that do this:
 *
 * - a key built from a constant imported from another module (a same-file
 *   constant resolves, so this is not a rule about constants);
 * - a key that is a PREFIX of another key, because a catalogue is nested JSON
 *   and the longer key needs an object where the shorter one put a string.
 *
 * The exit status is therefore useless here and reading it would certify an
 * incomplete catalogue. `--logs` is the only channel the suppressed messages
 * reach, and a clean extraction writes NO log file at all — so the failure
 * signal is the file's existence, which needs no parsing.
 *
 * Each extraction gets a fresh temporary directory. A log left over from an
 * earlier run is otherwise indistinguishable from a fault, which is the one way
 * this gate reports a failure that is not there.
 *
 * Scoped to `packages` as ONE extraction rather than one per package: a prefix
 * collision is a property of the whole catalogue, so two packages whose keys
 * collide would each extract cleanly on their own.
 *
 * Complements `examples/order-flow/theia`'s catalogue test, which checks the
 * other direction — that every translated key names real source. Neither sees
 * what the other does: that test reads the catalogue, and a dropped key is
 * absent from both sides at once.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/**
 * The `theia` binary, resolved through the manifest rather than through `npx`.
 *
 * `npx` would fetch the package from the registry when it is absent, turning a
 * broken install into a slow success against some other version — and a gate
 * that silently changes which tool it runs is measuring nothing it claims to.
 *
 * Reached through the hoisted copy a workspace package declares, and NOT
 * declared at the root beside this script. npm refuses an override for a
 * package the root depends on directly unless the two specs are byte-identical,
 * and the Theia compatibility workflow pins every `@theia/*` to one literal
 * version per leg, which no range can equal. A root declaration therefore fails
 * that workflow's install outright, before it can ask its question.
 */
const cliManifestPath = require.resolve('@theia/cli/package.json');
const theiaCli = join(dirname(cliManifestPath), require(cliManifestPath).bin.theia);

/** Catalogue keys, which Theia nests by `/`, flattened back to the codes they were written as. */
function flattenKeys(node, prefix = '') {
   return Object.entries(node).flatMap(([key, value]) => {
      const joined = prefix ? `${prefix}/${key}` : key;
      return typeof value === 'string' ? [joined] : flattenKeys(value, joined);
   });
}

/**
 * Extract one root and report both halves of the outcome: the keys that made it
 * into the catalogue, and the diagnostics the extractor suppressed.
 *
 * `suppressed` being empty is the whole verdict — the extractor writes the log
 * file only when it has something to say.
 */
function extract(root, files) {
   const workDir = mkdtempSync(join(tmpdir(), 'hydranium-nls-'));
   const output = join(workDir, 'nls.json');
   const logs = join(workDir, 'nls-extract.log');
   try {
      const result = spawnSync(process.execPath, [theiaCli, 'nls-extract', '-o', output, '-r', root, '-f', files, '-l', logs], {
         cwd: repoRoot,
         encoding: 'utf-8'
      });
      if (result.status !== 0) {
         return { keys: [], suppressed: [`nls-extract exited ${result.status}: ${(result.stderr || '').trim()}`] };
      }
      const suppressed = existsSync(logs)
         ? readFileSync(logs, 'utf-8')
              .split('\n')
              .map(line => line.trim())
              .filter(Boolean)
         : [];
      // An absent output file means the extractor produced no catalogue at all,
      // which reads as "no keys" and must not read as "no problem".
      const keys = existsSync(output) ? flattenKeys(JSON.parse(readFileSync(output, 'utf-8'))) : [];
      return { keys, suppressed };
   } finally {
      rmSync(workDir, { recursive: true, force: true });
   }
}

/** The source trees whose keys must all survive extraction. */
const TARGETS = [{ name: 'framework packages', root: 'packages', files: '*/src/**/*.ts' }];

/**
 * Fixtures that MUST lose a key. The repo extracts cleanly today, so a clean run
 * carries no information about whether the gate still detects anything — and
 * this gate's failure mode is exactly indistinguishable from its success, since
 * a probe that has stopped detecting the drop reports a complete catalogue.
 *
 * One canary per suppression path, because they are different faults in the
 * extractor: an unresolvable reference and an occupied place in the nested JSON.
 *
 * `control` is a key each fixture declares that must SURVIVE. Without it a
 * fixture the gate never reached — a renamed directory, a glob that stopped
 * matching — extracts nothing, suppresses nothing, and would be reported as a
 * gate that went blind rather than as a fixture that went missing.
 */
const CANARIES = [
   {
      name: 'key built from a cross-file constant',
      root: 'scripts/fixtures/nls-extract-canary/cross-file',
      files: '**/*.ts',
      control: 'canary/cross-file/present'
   },
   {
      name: 'key that is a prefix of another key',
      root: 'scripts/fixtures/nls-extract-canary/prefix-collision',
      files: '**/*.ts',
      control: 'canary/prefix-collision/present'
   }
];

let failed = false;

for (const canary of CANARIES) {
   const { keys, suppressed } = extract(canary.root, canary.files);
   if (!keys.includes(canary.control)) {
      failed = true;
      console.error(`✗ SELF-TEST FAILED: the ${canary.name} canary was not reached — '${canary.control}' did not extract`);
   } else if (suppressed.length === 0) {
      failed = true;
      console.error(`✗ SELF-TEST FAILED: the ${canary.name} canary lost no key — this gate has gone blind`);
   } else {
      console.log(`✓ self-test: ${canary.name} loses a key as it must`);
   }
}
console.log('');

for (const target of TARGETS) {
   const { keys, suppressed } = extract(target.root, target.files);
   if (keys.length === 0) {
      failed = true;
      console.error(`✗ ${target.name}: extraction produced no keys at all — this gate scanned nothing`);
   } else if (suppressed.length > 0) {
      failed = true;
      console.error(`✗ ${target.name}: ${suppressed.length} key(s) were dropped from the catalogue and the command still exited 0:`);
      for (const message of suppressed) {
         console.error(`    ${message}`);
      }
   } else {
      console.log(`✓ ${target.name}: all ${keys.length} host-bound keys survive extraction`);
   }
}

if (failed) {
   console.error('\nCatalogue gate failed: give every `nls.localize` an inline key that is no other key’s prefix.');
   console.error('(A SELF-TEST failure means the opposite — the gate stopped detecting, so fix the gate.)');
   process.exit(1);
}
