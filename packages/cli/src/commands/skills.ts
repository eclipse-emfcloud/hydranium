/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'import-meta-resolve';
import { parse } from 'yaml';

/** A compatibility result applies to one installed copy, not just its skill name. */
export interface SkillCompatibility {
   readonly file: string;
   readonly status: 'compatible' | 'incompatible' | 'unverified';
   readonly detail: string;
}

export const SKILL_DIRECTORIES = ['.agents/skills', '.claude/skills'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve from the adopter, never from a globally installed CLI's dependencies. */
export function installedPackageManifest(name: string, from: string): Record<string, unknown> | undefined {
   const parent = path.join(path.resolve(from), 'package.json');
   let manifest: string;
   try {
      manifest = createRequire(parent).resolve(`${name}/package.json`);
   } catch {
      try {
         let directory = path.dirname(fileURLToPath(resolve(name, pathToFileURL(parent).href)));
         while (true) {
            const candidate = path.join(directory, 'package.json');
            if (fs.existsSync(candidate)) {
               const value: unknown = JSON.parse(fs.readFileSync(candidate, 'utf8'));
               if (isRecord(value) && value.name === name) {
                  return value;
               }
            }
            const next = path.dirname(directory);
            if (next === directory) {
               return undefined;
            }
            directory = next;
         }
      } catch {
         return undefined;
      }
   }
   const value: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'));
   return isRecord(value) && value.name === name ? value : undefined;
}

/** Missing or malformed requirements never constitute evidence of compatibility. */
export function checkSkill(file: string, from: string): SkillCompatibility {
   const result = (status: SkillCompatibility['status'], detail: string): SkillCompatibility => ({ file, status, detail });
   try {
      const text = fs.readFileSync(file, 'utf8');
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
      const skill: unknown = frontmatter === undefined ? undefined : parse(frontmatter);
      const metadata = isRecord(skill) ? skill.metadata : undefined;
      if (!isRecord(metadata) || metadata['hydranium-compatibility-schema'] !== '1') {
         return result('unverified', 'No supported Hydranium compatibility metadata.');
      }
      const encoded = metadata['hydranium-contracts'];
      const contracts: unknown = typeof encoded === 'string' ? JSON.parse(encoded) : undefined;
      if (
         !isRecord(contracts) ||
         Object.keys(contracts).length === 0 ||
         Object.entries(contracts).some(
            ([name, declarations]) =>
               !/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ||
               !isRecord(declarations) ||
               Object.keys(declarations).length === 0 ||
               Object.entries(declarations).some(
                  ([contract, revision]) => !contract.trim() || typeof revision !== 'string' || !revision.trim()
               )
         )
      ) {
         return result('unverified', 'Invalid package contract requirements.');
      }
      const problems: string[] = [];
      const versions: string[] = [];
      let mismatch = false;
      for (const [name, requiredContracts] of Object.entries(contracts)) {
         const manifest = installedPackageManifest(name, from);
         const version = manifest?.version;
         const configuration = manifest?.hydranium;
         const suppliedContracts = isRecord(configuration) ? configuration.skillContracts : undefined;
         const contractMatches =
            isRecord(requiredContracts) &&
            isRecord(suppliedContracts) &&
            Object.entries(requiredContracts).every(
               ([contract, revision]) => Object.hasOwn(suppliedContracts, contract) && suppliedContracts[contract] === revision
            );
         if (manifest === undefined) {
            problems.push(`${name} is not installed; install dependencies and retry.`);
         } else if (!contractMatches) {
            mismatch = true;
            problems.push(`${name} does not declare the required skill contracts.`);
         } else {
            versions.push(`${name}${typeof version === 'string' ? `@${version}` : ''} (declared skill contract)`);
         }
      }
      return problems.length > 0
         ? result(mismatch ? 'incompatible' : 'unverified', problems.join(' '))
         : result('compatible', `Declared requirements satisfied by ${versions.join(', ')}.`);
   } catch (error) {
      return result('unverified', error instanceof Error ? error.message : String(error));
   }
}

/** Check every selected copy so an outdated agent-specific copy cannot hide behind a shared one. */
export function checkSkills(project: string, from = project, names?: readonly string[]): SkillCompatibility[] {
   const results: SkillCompatibility[] = [];
   const found = new Set<string>();
   for (const directory of SKILL_DIRECTORIES) {
      const root = path.join(project, directory);
      if (!fs.existsSync(root)) {
         continue;
      }
      for (const name of fs.readdirSync(root)) {
         if (!(names ? names.includes(name) : name.startsWith('hydranium-'))) {
            continue;
         }
         found.add(name);
         results.push(checkSkill(path.join(root, name, 'SKILL.md'), from));
      }
   }
   for (const name of names ?? []) {
      if (!found.has(name)) {
         results.push({ file: name, status: 'unverified', detail: 'Skill is not installed in a checked project directory.' });
      }
   }
   if (results.length === 0) {
      results.push({ file: project, status: 'unverified', detail: 'No Hydranium project skills found.' });
   }
   return results;
}
