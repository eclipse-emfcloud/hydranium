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
 * Names the cold-clone false green, which is otherwise silent and then
 * misattributed.
 *
 * `hydranium-cli` is a workspace package whose `lib/` is generated and
 * gitignored, so on a fresh clone its `bin` target does not exist at the moment
 * npm links binaries. npm skips such a link rather than warning, so the install
 * exits 0 with `node_modules/.bin/hydranium-cli` absent, and the failure surfaces
 * layers away: an example's `generate` step dies on `hydranium-cli: not found`
 * with exit 127, reported several times as npm unwinds the script chain, with the
 * middle report naming the code generator so the tail of the log invites blaming
 * it. The remedy — build, then install again — is documented, and the defect is
 * that nothing points a reader at it.
 *
 * ## This must warn and MUST NOT exit non-zero
 *
 * On a genuine first install `lib/` is legitimately absent: that IS the state the
 * documented sequence starts from. Failing here would break the very sequence the
 * hint exists to recommend, which is the bug this script fixes, one layer up. Two
 * earlier attempts to catch this from a workspace `prepare` script died on
 * install ordering; a `postinstall` runs after the install and therefore knows the
 * answer instead of racing it.
 *
 * It also reaches no consumer of a published package: a registry consumer runs the
 * published package's own scripts, never this root's.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The bin target npm would have linked. Checking the target rather than the link
 * keeps the probe honest on a platform where the link is a shim rather than a
 * symlink, and it is the file whose absence is the actual cause.
 */
const CLI_ENTRY = join(REPO_ROOT, 'packages/cli/lib/cli.js');

if (!existsSync(CLI_ENTRY)) {
   process.stderr.write(
      [
         '',
         'NOTE: packages/cli/lib/cli.js does not exist, so npm has not linked the',
         '      hydranium-cli binary. This is expected on a fresh clone.',
         '',
         '      Until it is linked, a build fails inside an EXAMPLE with',
         '      "sh: 1: hydranium-cli: not found" (exit 127), which names neither',
         '      this package nor the cause.',
         '',
         '      Build first, then install once more so the link is made:',
         '',
         '          npm run build',
         '          npm install',
         '',
         '      CONTRIBUTING.md has the full first-run sequence.',
         ''
      ].join('\n')
   );
}

// Deliberately no explicit exit code: this script only ever reports.
