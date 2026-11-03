/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { checkSkill, checkSkills } from '../src/commands/skills.js';
import { runCheckSkillsCommand } from '../src/commands/check-skills-args.js';

let project: string;
beforeEach(() => {
   project = fs.mkdtempSync(path.join(os.tmpdir(), 'hydranium-skills-'));
});
afterEach(() => {
   vi.restoreAllMocks();
   process.exitCode = 0;
   fs.rmSync(project, { recursive: true, force: true });
});

function write(relative: string, content: string): string {
   const file = path.join(project, relative);
   fs.mkdirSync(path.dirname(file), { recursive: true });
   fs.writeFileSync(file, content);
   return file;
}

function installed(version: string, local = '', exported = false): void {
   write(
      `${local}node_modules/@hydranium/core/package.json`,
      JSON.stringify({
         name: '@hydranium/core',
         version,
         type: 'module',
         ...(exported ? { exports: { '.': './lib/index.js' } } : {})
      })
   );
   if (exported) {
      write(`${local}node_modules/@hydranium/core/lib/index.js`, 'throw new Error("must not execute packages");');
   }
}

function skill(range: string, directory = '.agents/skills'): string {
   return write(
      `${directory}/hydranium-profiling/SKILL.md`,
      `---\n${stringify({
         name: 'hydranium-profiling',
         description: 'Interpret a profile.',
         metadata: {
            'hydranium-compatibility-schema': '1',
            'hydranium-requires': JSON.stringify({ '@hydranium/core': range })
         }
      })}---\nInstructions.\n`
   );
}

describe('checkSkills', () => {
   it.each(['1.0.0-next', '1.0.0-next.9999'])('accepts the shipped profiling contracts after release stamping to %s', version => {
      for (const name of ['core', 'cli']) {
         const manifest = JSON.parse(fs.readFileSync(new URL(`../../${name}/package.json`, import.meta.url), 'utf8'));
         write(`node_modules/@hydranium/${name}/package.json`, JSON.stringify({ ...manifest, version }));
         write(`node_modules/@hydranium/${name}/lib/index.js`, 'throw new Error("must not load packages");');
      }
      const file = write(
         '.agents/skills/hydranium-profiling/SKILL.md',
         fs.readFileSync(new URL('../../../skills/hydranium-profiling/SKILL.md', import.meta.url), 'utf8')
      );
      expect(checkSkill(file, project).status).toBe('compatible');
      for (const contract of [undefined, { profiling: '2' }]) {
         const manifest = JSON.parse(fs.readFileSync(new URL('../../core/package.json', import.meta.url), 'utf8'));
         write('node_modules/@hydranium/core/package.json', JSON.stringify({ ...manifest, version, hydraniumSkillContracts: contract }));
         expect(checkSkill(file, project).status).toBe('incompatible');
      }
   });

   it('resolves the server package version through an export map without executing it', () => {
      installed('2.0.0');
      installed('1.0.0-next.411', 'server/', true);
      skill('1.0.0-next.411');
      expect(checkSkills(project, path.join(project, 'server'))[0].status).toBe('compatible');
      expect(checkSkills(project)[0].status).toBe('incompatible');
   });

   it.each([
      ['1.0.0-next.410', 'incompatible'],
      ['1.0.0-next.411', 'compatible'],
      ['1.0.0-next.412', 'incompatible'],
      ['1.0.0', 'incompatible']
   ])('checks the declared prerelease boundary for %s', (version, status) => {
      installed(version);
      skill('1.0.0-next.411');
      expect(checkSkills(project)[0].status).toBe(status);
   });

   it('reports an outdated agent copy even when the shared copy is compatible', () => {
      installed('1.0.0');
      skill('^1.0.0');
      skill('^2.0.0', '.claude/skills');
      expect(checkSkills(project).map(result => result.status)).toEqual(['compatible', 'incompatible']);
   });

   it('does not substitute the CLI dependencies for an uninstalled adopter dependency', () => {
      skill('1.0.0-next.411');
      expect(checkSkills(project)[0]).toMatchObject({ status: 'unverified', detail: expect.stringContaining('not installed') });
   });

   it('does not certify upstream instructions or an empty skill selection', () => {
      expect(checkSkills(project)[0].status).toBe('unverified');
      write('.agents/skills/langium/SKILL.md', '---\nname: langium\ndescription: Upstream\n---\n');
      expect(checkSkills(project)[0].status).toBe('unverified');
      expect(checkSkills(project, project, ['hydranium-profiling'])[0].detail).toContain('not installed');
   });

   it.each(['{}', '{"@hydranium/core":""}', '{"@hydranium/core":"nonsense"}', '{broken'])('refuses malformed requirements %s', encoded => {
      const file = write(
         '.agents/skills/hydranium-profiling/SKILL.md',
         `---\n${stringify({
            metadata: { 'hydranium-compatibility-schema': '1', 'hydranium-requires': encoded }
         })}---\n`
      );
      expect(checkSkill(file, project).status).toBe('unverified');
   });

   it('ignores unrelated skills but checks a specifically requested missing skill', () => {
      installed('1.0.0');
      skill('^1.0.0');
      write('.agents/skills/unrelated/SKILL.md', 'no metadata');
      expect(checkSkills(project)).toHaveLength(1);
      expect(checkSkills(project, project, ['missing'])[0].status).toBe('unverified');
   });
});

describe('check-skills', () => {
   it('fails CI for incompatible or unverified skills and can select the framework skill alone', () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      installed('1.0.0');
      skill('^2.0.0');
      runCheckSkillsCommand([project]);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      skill('^1.0.0');
      write('.agents/skills/langium/SKILL.md', '---\nname: langium\n---\n');
      runCheckSkillsCommand([project]);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      runCheckSkillsCommand([project, '--skill', 'hydranium-profiling']);
      expect(process.exitCode).toBe(0);
   });
});
