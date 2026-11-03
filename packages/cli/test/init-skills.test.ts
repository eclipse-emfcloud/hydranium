/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInitCommand } from '../src/commands/init-args.js';
import { installSkills, offerSkills, parseSkillInstallation } from '../src/commands/init-skills.js';
import { InitWizardCancelled, type PromptPort } from '../src/commands/init-prompt.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
let project: string;
beforeEach(() => {
   project = fs.mkdtempSync(path.join(os.tmpdir(), 'hydranium-init-skills-'));
   vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
   vi.mocked(spawnSync).mockReturnValue({ pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null });
});
afterEach(() => {
   vi.restoreAllMocks();
   vi.mocked(spawnSync).mockReset();
   fs.rmSync(project, { recursive: true, force: true });
});

describe('init --skills', () => {
   it('downloads only selected skills after the scaffold exists and uses copies for each selected agent', async () => {
      let scaffoldExistedAtDownload = false;
      vi.mocked(spawnSync).mockImplementation(command => {
         if (command === 'npx' || command === 'npx.cmd') {
            scaffoldExistedAtDownload = fs.existsSync(path.join(project, 'server/package.json'));
         }
         return { pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null };
      });
      await runInitCommand([project, '--name', 'Example', '--skills', 'langium', '--agents', 'codex,claude-code']);
      const calls = vi.mocked(spawnSync).mock.calls.filter(([command]) => command === 'npx' || command === 'npx.cmd');
      expect(calls).toHaveLength(1);
      expect(scaffoldExistedAtDownload).toBe(true);
      expect(calls[0][2]?.cwd).toBe(project);
      expect(calls[0][1]).toEqual([
         '--yes',
         'skills@1.7.6',
         'add',
         'eclipse-langium/langium-ai',
         '--skill',
         'langium',
         '--agent',
         'codex',
         'claude-code',
         '--copy',
         '--yes'
      ]);
   });

   it('keeps a noninteractive scaffold offline without a skill selection', async () => {
      await runInitCommand([project, '--name', 'Example']);
      expect(vi.mocked(spawnSync).mock.calls.some(([command]) => command === 'npx' || command === 'npx.cmd')).toBe(false);
   });

   it('rejects invalid selections before writing the scaffold', async () => {
      await expect(runInitCommand([project, '--name', 'Example', '--skills', 'langium'])).rejects.toThrow('--agents');
      expect(fs.readdirSync(project)).toEqual([]);
      expect(() => parseSkillInstallation('langium', 'codex;echo')).toThrow('Unknown agent');
   });

   it('keeps the scaffold and prints a retry when a download fails', async () => {
      vi.mocked(spawnSync).mockReturnValue({ pid: 1, output: [], stdout: '', stderr: '', status: 1, signal: null });
      await runInitCommand([project, '--name', 'Example', '--skills', 'hydranium-profiling', '--agents', 'codex']);
      expect(fs.existsSync(path.join(project, 'server/package.json'))).toBe(true);
      const output = vi.mocked(process.stdout.write).mock.calls.flat().join('');
      expect(output).toContain('Retry in');
      expect(output).toContain('npx --yes skills@1.7.6 add');
   });

   it('writes workspace skills at the root without changing its manifest', async () => {
      const manifest = JSON.stringify({ name: 'workspace', private: true, workspaces: ['languages/*/*'] });
      fs.writeFileSync(path.join(project, 'package.json'), manifest);
      const target = path.join(project, 'languages/example');
      await runInitCommand([target, '--name', 'Example', '--monorepo', '--skills', 'langium', '--agents', 'codex']);
      const calls = vi.mocked(spawnSync).mock.calls.filter(([command]) => command === 'npx' || command === 'npx.cmd');
      expect(calls).toHaveLength(1);
      expect(calls[0][2]?.cwd).toBe(project);
      expect(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).toBe(manifest);
   });
});

describe('offerSkills', () => {
   function prompt(confirm: () => Promise<boolean>): PromptPort {
      return {
         intro: vi.fn(),
         outro: vi.fn(),
         note: vi.fn(),
         confirm,
         text: vi.fn(),
         select: vi.fn(),
         multiselect: vi.fn()
      };
   }

   it('does not ask for agents or install when the offer is declined', async () => {
      const port = prompt(async () => false);
      expect(await offerSkills(port, project)).toBeUndefined();
      expect(port.multiselect).not.toHaveBeenCalled();
   });

   it('offers both skills and returns only the agents the user selected', async () => {
      const port = prompt(async () => true);
      vi.mocked(port.multiselect).mockResolvedValueOnce(['hydranium-profiling', 'langium']).mockResolvedValueOnce(['claude-code']);
      expect(await offerSkills(port, project)).toEqual({ skills: ['hydranium-profiling', 'langium'], agents: ['claude-code'] });
      expect(port.multiselect).toHaveBeenCalledWith(expect.objectContaining({ initialValues: ['hydranium-profiling', 'langium'] }));
   });

   it('treats cancellation after scaffolding as skipping the optional step', async () => {
      const port = prompt(async () => {
         throw new InitWizardCancelled();
      });
      expect(await offerSkills(port, project)).toBeUndefined();
      expect(port.outro).toHaveBeenCalledWith('Skills skipped. Scaffold kept.');
   });
});

describe('installSkills', () => {
   it('stops the remaining downloads when the installer is interrupted', () => {
      vi.mocked(spawnSync).mockReturnValue({ pid: 1, output: [], stdout: '', stderr: '', status: 130, signal: null });
      installSkills(project, project, { skills: ['hydranium-profiling', 'langium'], agents: ['codex'] });
      expect(spawnSync).toHaveBeenCalledTimes(1);
   });
   it('continues to the other selected skill after a failed download', () => {
      vi.mocked(spawnSync).mockReturnValue({ pid: 1, output: [], stdout: '', stderr: '', status: 1, signal: null });
      const output: string[] = [];
      installSkills(project, project, { skills: ['hydranium-profiling', 'langium'], agents: ['codex'] }, line => output.push(line));
      expect(spawnSync).toHaveBeenCalledTimes(2);
      expect(output.join('')).toContain('--skill langium');
   });
});
