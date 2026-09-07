/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { LogThreshold, Project, TransferElement } from '@hydranium/protocol';
import type { DataServerProtocol } from '@hydranium/protocol/data';
import { logLevelEnv } from '../log-level.js';
import { withDataServer } from '../spawn-data-server.js';

/**
 * Options for the {@link runProjects} subcommand. `serverCommand` /
 * `serverArgs` mirror what an adopter would pass to spawn the data-server
 * subprocess.
 */
export interface ProjectsCommandOptions {
   /**
    * Command-line tokens used to spawn the data-server child. Mirrors
    * the `--server "<cmd> [args...]"` shape on the CLI surface — split
    * into command + args here so callers don't have to handle quoting.
    */
   readonly serverCommand: string;
   readonly serverArgs?: readonly string[];
   readonly cwd?: string;
   /** Log threshold for the spawned server, set on its `HYDRANIUM_LOG_LEVEL` env. */
   readonly logLevel?: LogThreshold;
   /**
    * Output sink. Default: `process.stdout.write`. Tests inject a
    * capturing stub.
    */
   readonly write?: (line: string) => void;
   /**
    * Test-only injection: skip the spawn + use this proxy directly. The
    * production CLI never passes this; subcommand unit tests do.
    */
   readonly __proxyForTest?: DataServerProtocol<TransferElement>;
}

/**
 * Print the projects exposed by the data-server as one JSON object per
 * line (newline-delimited JSON). Each line is independently parseable —
 * adopters piping the output into `jq` or another line-oriented tool
 * don't need to wait for end-of-stream.
 */
export async function runProjects(options: ProjectsCommandOptions): Promise<void> {
   const write = options.write ?? ((line: string) => process.stdout.write(line));

   if (options.__proxyForTest) {
      const projects = await options.__proxyForTest.getProjects();
      writeProjects(projects, write);
      return;
   }

   await withDataServer(
      {
         command: options.serverCommand,
         args: options.serverArgs,
         cwd: options.cwd,
         env: options.logLevel ? logLevelEnv(options.logLevel) : undefined
      },
      async server => {
         const projects = await server.getProjects();
         writeProjects(projects, write);
      }
   );
}

function writeProjects(projects: readonly Project[], write: (line: string) => void): void {
   for (const project of projects) {
      write(`${JSON.stringify(project)}\n`);
   }
}
