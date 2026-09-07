/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `hydranium-cli query` / `save` against a **real** stdio data-server.
 *
 * Both subcommands spawn a server command and talk JSON-RPC over its
 * stdin/stdout, so what they need to be tested against is an entry with a real
 * Langium stack behind it — which is what this package's
 * `lib/data-server-main.js` provides. The CLI package's own coverage either
 * injects a proxy without spawning at all or spawns a hand-written stub; neither
 * has a document builder, so neither can observe what the subcommands actually
 * ask for.
 *
 * That distinction is load-bearing, because both call `getModelDocument({
 * includeDiagnostics: true })`, which settles at `DocumentState.Validated` rather
 * than at the resolve-only state. So the assertions here are on diagnostic
 * **content**: a test that only checked the envelope arrived would pass against a
 * server that resolved without ever validating, and against a stub answering the
 * request from a literal.
 *
 * Runs against a scratch copy, because `save` writes to disk and because a
 * rebuild runs the integrity rules (see `makeScratchWorkspace`'s own docs).
 */

import { runQuery, runSave } from '@hydranium/cli';
import { makeScratchWorkspace, type ScratchWorkspace } from '@hydranium/core/testing/node';
import { URI } from '@hydranium/langium';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKSPACE_FILES, WORKSPACE_ROOT } from './order-flow-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The compiled stdio entry, which `turbo run test`'s `dependsOn: ["build"]`
 * guarantees exists. Pointed at `lib/` rather than `src/` on purpose: the CLI
 * spawns a plain `node <file>` child, so what is under test is the artefact an
 * adopter ships, not a transpiled-on-the-fly copy of it.
 */
const SERVER_ENTRY = path.resolve(HERE, '../lib/data-server-main.js');

/**
 * Booting three grammars over the sample workspace in a cold subprocess is well
 * past vitest's 5s default, and a timeout here reads as a hang rather than as
 * slowness.
 */
const SPAWN_TIMEOUT_MS = 60_000;

let workspace: ScratchWorkspace | undefined;

beforeEach(() => {
   workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-cli-stdio-' });
});

afterEach(() => {
   workspace?.dispose();
   workspace = undefined;
});

/** The scratch workspace, or a throw naming the missing setup rather than a `undefined` deref. */
function scratch(): ScratchWorkspace {
   if (!workspace) {
      throw new Error('scratch workspace not initialized');
   }
   return workspace;
}

/** Absolute `file:` URI of a workspace-relative path — what the wire carries. */
function uriOf(relativePath: string): string {
   return URI.file(path.join(scratch().root, relativePath)).toString();
}

/** The spawn options every case shares: `node <entry>`, rooted at the scratch copy. */
function serverSpawn(): { serverCommand: string; serverArgs: readonly string[]; cwd: string } {
   // No explicit workspace argument: the entry defaults to its cwd, which is the
   // `--cwd` the CLI sets on the child. Exercising the default is the point —
   // it is the shape a user gets from `hydranium-cli query --cwd <workspace>`.
   return { serverCommand: 'node', serverArgs: [SERVER_ENTRY], cwd: scratch().root };
}

/** Run `query` and parse the single JSON line it writes. */
async function query(relativePath: string): Promise<Record<string, unknown>> {
   const lines: string[] = [];
   await runQuery({ ...serverSpawn(), uri: uriOf(relativePath), write: line => lines.push(line) });
   expect(lines).toHaveLength(1);
   return JSON.parse(lines[0]);
}

describe('hydranium-cli over a real stdio data-server', () => {
   it(
      'query: returns the document envelope, with the diagnostics the request asked for',
      async () => {
         // `audit-leak.domain` is the workspace's one intended error: it names a
         // declaration that its project cannot see. Asserting the MESSAGE, not
         // just that some array arrived, is what makes this a regression gate on
         // `includeDiagnostics` actually settling at `Validated`.
         const envelope = await query(WORKSPACE_FILES.auditLeak);

         expect(envelope.uri).toBe(uriOf(WORKSPACE_FILES.auditLeak));
         const diagnostics = envelope.diagnostics as ReadonlyArray<{ message: string }>;
         expect(diagnostics.map(diagnostic => diagnostic.message).join('\n')).toContain('AuditStamp');
      },
      SPAWN_TIMEOUT_MS
   );

   it(
      'query: routes a second grammar over the same connection',
      async () => {
         // One DataServer serves all three languages, so the URI alone selects
         // the serializer. A single-grammar example cannot tell a correct router
         // from one that always answers with the only language it has.
         const envelope = await query(WORKSPACE_FILES.fulfillmentProcess);

         const root = envelope.root as { $type: string };
         expect(root.$type).toBe('ProcessModel');
         // The clean file: whatever else it carries, not the visibility error.
         const diagnostics = (envelope.diagnostics ?? []) as ReadonlyArray<{ message: string }>;
         expect(diagnostics.map(diagnostic => diagnostic.message).join('\n')).not.toContain('AuditStamp');
      },
      SPAWN_TIMEOUT_MS
   );

   it(
      'save: persists the new text to disk and echoes the post-save envelope',
      async () => {
         const relativePath = WORKSPACE_FILES.commerceCoreInternal;
         const before = readFileSync(path.join(scratch().root, relativePath), 'utf8');
         expect(before).not.toContain('CarrierCode');

         const lines: string[] = [];
         await runSave({
            ...serverSpawn(),
            uri: uriOf(relativePath),
            content: `${before}\n\nentity CarrierCode {\n   code: string\n}\n`,
            clientId: 'cli-stdio-test',
            write: line => lines.push(line)
         });

         expect(lines).toHaveLength(1);
         const envelope = JSON.parse(lines[0]);
         expect(envelope.uri).toBe(uriOf(relativePath));
         // The write reached disk, not just the in-memory text store — `save` is
         // the one data-server path that is supposed to persist.
         expect(readFileSync(path.join(scratch().root, relativePath), 'utf8')).toContain('CarrierCode');
      },
      SPAWN_TIMEOUT_MS
   );
});
