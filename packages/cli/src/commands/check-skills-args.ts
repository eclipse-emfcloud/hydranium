/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as path from 'node:path';
import { exitWithUsage, helpRequested, printHelp } from './harness-args.js';
import { checkSkills } from './skills.js';

export const CHECK_SKILLS_HELP = [
   'Usage: hydranium-cli check-skills [project-directory] [--from <directory>] [--skill <names>]',
   '',
   'Check declared compatibility of installed Hydranium and Langium skills.',
   'Reads .agents/skills and .claude/skills in the project directory (default: cwd).',
   'Checks every copy. Does not download, update, or execute skills.',
   'Exits non-zero for incompatible, missing, malformed, or unverified skills.',
   '',
   '  --from <directory>   Resolve installed packages from this directory, relative',
   '                       to the project. Default: the project directory.',
   '                       Use the server package for workspace-local dependencies.',
   '  --skill <names>      Check only these comma-separated skill names.',
   '                       Default: hydranium-* and langium.',
   '',
   'A compatible result checks package ranges or declared skill contracts,',
   'not the accuracy of prose.',
   'Upstream skills without Hydranium metadata are unverified.'
];

export function runCheckSkillsCommand(args: string[]): void {
   if (helpRequested(args, ['--from', '--skill'])) {
      printHelp(CHECK_SKILLS_HELP);
      return;
   }
   let project: string | undefined;
   let from: string | undefined;
   let names: string[] | undefined;
   for (let index = 0; index < args.length; index++) {
      const argument = args[index];
      if (argument === '--from' || argument === '--skill') {
         const value = args[++index];
         if (!value || value.startsWith('--')) {
            exitWithUsage(`Missing value for ${argument}`);
         }
         if (argument === '--from') {
            from = value;
         } else {
            names = value.split(',');
            if (names.some(name => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
               exitWithUsage('Invalid skill name.');
            }
         }
      } else if (argument.startsWith('-') || project !== undefined) {
         exitWithUsage(`Unexpected argument: ${argument} (hydranium-cli check-skills --help)`);
      } else {
         project = argument;
      }
   }
   const root = path.resolve(project ?? '.');
   const results = checkSkills(root, path.resolve(root, from ?? '.'), names);
   for (const result of results) {
      console.log(`${result.status}: ${result.file}: ${result.detail}`);
   }
   if (results.some(result => result.status !== 'compatible')) {
      process.exitCode = 1;
   }
}
