#!/usr/bin/env node
/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * License-header rewrite tool.
 *
 * Idempotent. Adds the canonical hydranium license block to a file while
 * preserving any pre-existing copyright lines (the "preservation rule" — never
 * strip an existing copyright holder, ours or a third party's).
 * A leading `#!` shebang stays on the first line, with the header below it.
 *
 * The tool never ADDS a holder to a file that already names one. A copyright
 * line is a claim about who wrote the code, and this tool cannot know that: a
 * new file may come from anyone. {@link DEFAULT_COPYRIGHT} therefore applies
 * only to a file with no copyright line at all, and whoever adds a co-author
 * writes that line themselves.
 *
 * Usage:
 *   node scripts/header.mjs <file> [<file>...]
 *   node scripts/header.mjs --check <file>...     # exit 1 if any file lacks the header
 *   node scripts/header.mjs --check-all           # same, over every source file
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CURRENT_YEAR = new Date().getFullYear();

/**
 * The copyright line for a file that carries none. Used on new files only —
 * existing holders are preserved verbatim, never supplemented.
 */
const DEFAULT_COPYRIGHT = `Copyright (c) ${CURRENT_YEAR} EclipseSource and others.`;

const SPDX_LINE = 'SPDX-License-Identifier: MIT';

const LICENSE_BODY = [
   ' *',
   ' * This program and the accompanying materials are made available under the',
   ' * terms of the MIT License which is available in the project root.',
   ' *',
   ` * ${SPDX_LINE}`
];

const HEADER_TOP = '/' + '*'.repeat(80);
const HEADER_BOTTOM = ' ' + '*'.repeat(80) + '/';

const COPYRIGHT_RE = /^\s*\*\s*Copyright\s*\(c\)\s*[^\n]+/;

const SHEBANG_RE = /^#![^\n]*\r?\n/;

/**
 * Split off a leading `#!` shebang line, which must stay the very first line of
 * the file for the interpreter to find it. Returns the shebang (including its
 * newline, or `''` when absent) and the remaining source.
 */
function splitShebang(src) {
   const match = src.match(SHEBANG_RE);
   if (match === null) {
      return { shebang: '', body: src };
   }
   return { shebang: match[0], body: src.slice(match[0].length) };
}

/**
 * Parse the leading block comment (if any) from `src`. Returns the comment
 * lines and the rest of the file.
 */
function splitLeadingBlockComment(src) {
   if (!src.startsWith('/*')) {
      return { commentLines: [], rest: src };
   }
   const end = src.indexOf('*/');
   if (end === -1) {
      return { commentLines: [], rest: src };
   }
   const commentBlock = src.slice(0, end + 2);
   const lines = commentBlock.split(/\r?\n/);
   const after = src.slice(end + 2);
   const rest = after.replace(/^\r?\n/, '');
   return { commentLines: lines, rest };
}

/**
 * Extract every copyright line from a list of comment lines, preserving order.
 */
function extractCopyrights(commentLines) {
   return commentLines.filter(line => COPYRIGHT_RE.test(line)).map(line => line.replace(/^\s*\*\s*/, ' * '));
}

/**
 * Build the canonical header. `copyrights` is a list of pre-existing
 * `* Copyright (c) ...` lines (already prefixed with ` * `), kept verbatim and
 * in order. Only a file with none of them gets {@link DEFAULT_COPYRIGHT}.
 */
function buildHeader(copyrights) {
   const lines = [HEADER_TOP];
   if (copyrights.length === 0) {
      lines.push(` * ${DEFAULT_COPYRIGHT}`);
   } else {
      lines.push(...copyrights);
   }
   lines.push(...LICENSE_BODY);
   lines.push(HEADER_BOTTOM);
   return lines.join('\n');
}

/**
 * Apply the canonical header to a file. Idempotent.
 *
 * The header is followed by exactly one blank line before the first line of
 * code — the convention every source file in the repo already follows. A
 * shebang, when present, is re-emitted above the header.
 */
function applyHeader(file) {
   const src = readFileSync(file, 'utf-8');
   const { shebang, body: afterShebang } = splitShebang(src);
   const { commentLines, rest } = splitLeadingBlockComment(afterShebang.replace(/^\r?\n+/, ''));
   const copyrights = extractCopyrights(commentLines);
   const header = buildHeader(copyrights);
   const body = rest.replace(/^\r?\n+/, '');
   const next = shebang + header + (body.length === 0 ? '\n' : '\n\n' + body);
   if (next === src) {
      return false; // unchanged
   }
   writeFileSync(file, next, 'utf-8');
   return true;
}

/**
 * Check whether a file already contains the SPDX line.
 */
function hasHeader(file) {
   const src = readFileSync(file, 'utf-8');
   return src.includes(SPDX_LINE);
}

/** File types that carry the license header. */
const HEADER_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.cjs', '.js', '.css'];

/**
 * Paths deliberately exempt from `--check-all`. Each is generated or
 * tool-local, so a header would either be wiped on the next run or ship
 * nowhere:
 *
 * - `**\/generated/` — langium-cli output, rewritten by every codegen run.
 * - `**\/generated-transfer/` — `hydranium-cli generate-transfer-model` output.
 *   Same rewritten-by-codegen reason, plus one specific to this generator: it
 *   runs in ADOPTER repos, so teaching it to emit this repo's copyright header
 *   would stamp our notice onto someone else's generated code. It emits its own
 *   "DO NOT EDIT" banner with the regen command instead. The directory is
 *   separate from `generated/` because langium-cli treats its own output
 *   directory as exclusive and offers to delete anything else there.
 * - `esbuild.mjs` — Theia app scaffolding; deleting it and re-running
 *   `theia build` regenerates it.
 * - `.prettierrc.js` — formatter config, never published.
 *
 * `.langium` grammars are absent from {@link HEADER_EXTENSIONS} for the same
 * reason: they carry no header today.
 */
const HEADER_EXEMPT = [/(^|\/)generated\//, /(^|\/)generated-transfer\//, /(^|\/)esbuild\.mjs$/, /(^|\/)\.prettierrc\.js$/];

/**
 * Every source file the header gate covers: tracked files plus new untracked
 * ones (so a header-less file is caught before it is committed, not after),
 * minus ignored paths and the exemptions above.
 */
function listCoveredFiles() {
   const stdout = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024
   });
   return (
      stdout
         .split('\n')
         .filter(line => line.length > 0)
         .filter(file => HEADER_EXTENSIONS.some(extension => file.endsWith(extension)))
         .filter(file => !HEADER_EXEMPT.some(pattern => pattern.test(file)))
         .map(file => resolve(REPO_ROOT, file))
         // A staged deletion is still listed by `--cached`; skip what is gone.
         .filter(file => existsSync(file))
   );
}

function main() {
   const args = process.argv.slice(2);
   const checkAll = args.includes('--check-all');
   const checkOnly = checkAll || args.includes('--check');
   const files = checkAll ? listCoveredFiles() : args.filter(arg => arg !== '--check');

   if (files.length === 0) {
      console.error('Usage: node scripts/header.mjs [--check | --check-all] <file>...');
      process.exit(2);
   }

   let exitCode = 0;
   let missing = 0;
   for (const arg of files) {
      const file = resolve(arg);
      try {
         statSync(file);
      } catch {
         console.error(`Not found: ${file}`);
         exitCode = 1;
         continue;
      }

      if (checkOnly) {
         if (!hasHeader(file)) {
            console.error(`Missing header: ${file}`);
            missing++;
            exitCode = 1;
         }
      } else {
         const changed = applyHeader(file);
         console.log(`${changed ? 'updated' : 'unchanged'}: ${file}`);
      }
   }

   if (checkAll) {
      if (missing === 0) {
         console.log(`✓ all ${files.length} source files carry the ${SPDX_LINE} header`);
      } else {
         console.error(`\n${missing} of ${files.length} source files lack the header.`);
         console.error('Run `node scripts/header.mjs <file>...` to add it.');
      }
   }
   process.exit(exitCode);
}

main();
