/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Subprocess-spawned integration tier for the CLI subcommands. Unlike the unit
 * tiers, which inject `__proxyForTest` to bypass the spawn, this one starts a
 * Node subprocess running the `echo-server` fixture and drives the subcommands
 * against it through their real spawn path — the same OS-pipe stdio a production
 * deployment uses.
 *
 * Requires `npm run build` to have run beforehand — both the CLI itself and the
 * fixture compile to `lib/`, and the spawn helper points at those outputs. The
 * turbo pipeline orders `build` before `test`.
 */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProjects } from '../src/commands/projects.js';
import { runQuery } from '../src/commands/query.js';
import { runSave } from '../src/commands/save.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.resolve(__dirname, '../lib/testing/echo-server.js');
const FIXTURE_URI = 'file:///fixture/A.fake';
// The fixture seeds this document's name from its own HYDRANIUM_LOG_LEVEL env,
// so querying it reveals the log level the spawned child was launched with.
const ENV_ECHO_URI = 'file:///fixture/env.fake';

describe('CLI subprocess integration', () => {
   it('projects: spawns the fixture and writes each project as NDJSON', async () => {
      const lines: string[] = [];
      await runProjects({
         serverCommand: 'node',
         serverArgs: [FIXTURE_PATH],
         write: line => lines.push(line)
      });
      expect(lines).toHaveLength(2);
      const projects = lines.map(line => JSON.parse(line));
      expect(projects[0].id).toBe('fixture-p1');
      expect(projects[0].version).toBe('1.0.0');
      expect(projects[1].id).toBe('fixture-p2');
      expect(projects[1].dependencies).toEqual(['fixture-p1']);
   });

   it('query: spawns the fixture and prints the document envelope', async () => {
      const lines: string[] = [];
      await runQuery({
         serverCommand: 'node',
         serverArgs: [FIXTURE_PATH],
         uri: FIXTURE_URI,
         write: line => lines.push(line)
      });
      expect(lines).toHaveLength(1);
      const doc = JSON.parse(lines[0]);
      expect(doc.uri).toBe(FIXTURE_URI);
      expect(doc.root.name).toBe('initial');
   });

   it('save: spawns the fixture, updates the document, returns the post-save envelope', async () => {
      const lines: string[] = [];
      await runSave({
         serverCommand: 'node',
         serverArgs: [FIXTURE_PATH],
         uri: FIXTURE_URI,
         content: 'name:from-cli',
         clientId: 'cli-spawn-test',
         write: line => lines.push(line)
      });
      expect(lines).toHaveLength(1);
      const doc = JSON.parse(lines[0]);
      expect(doc.uri).toBe(FIXTURE_URI);
      expect(doc.root.name).toBe('from-cli');
   });

   it('logLevel: forwards the requested level onto the spawned server env', async () => {
      const lines: string[] = [];
      await runQuery({
         serverCommand: 'node',
         serverArgs: [FIXTURE_PATH],
         uri: ENV_ECHO_URI,
         logLevel: 'debug',
         write: line => lines.push(line)
      });
      expect(JSON.parse(lines[0]).root.name).toBe('debug');
   });

   it('logLevel: omitted leaves the server env untouched', async () => {
      const lines: string[] = [];
      await runQuery({
         serverCommand: 'node',
         serverArgs: [FIXTURE_PATH],
         uri: ENV_ECHO_URI,
         write: line => lines.push(line)
      });
      expect(JSON.parse(lines[0]).root.name).toBe('unset');
   });
});

describe('CLI subprocess hardening', () => {
   it('rejects with a clear message when the server command cannot be spawned', async () => {
      await expect(runProjects({ serverCommand: 'hydranium-cli-no-such-binary-xyz', write: () => undefined })).rejects.toThrow(
         /failed to start/
      );
   });

   it('rejects instead of hanging when the server reads the request then exits without answering', async () => {
      // The fixture's --exit-on-request mode reads a full request then dies without
      // replying — whenTerminated fires on the exit, failing fast.
      await expect(
         runProjects({
            serverCommand: 'node',
            serverArgs: [FIXTURE_PATH, '--exit-on-request'],
            write: () => undefined
         })
      ).rejects.toThrow(/exited before the request completed/);
   });
});
