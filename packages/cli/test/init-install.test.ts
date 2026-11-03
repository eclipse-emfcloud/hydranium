/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInitCommand } from '../src/commands/init-args.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const directories: string[] = [];
afterEach(() => {
   vi.restoreAllMocks();
   vi.mocked(spawnSync).mockReset();
   for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
   }
});

describe('init --install', () => {
   function setup(status = 0, error?: Error, signal: NodeJS.Signals | null = null) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydranium-install-'));
      directories.push(root);
      const target = path.join(root, 'project with spaces');
      const output: string[] = [];
      vi.spyOn(process, 'exit').mockImplementation(() => {
         throw new Error('CLI exited');
      });
      vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
         output.push(String(chunk));
         return true;
      });
      vi.mocked(spawnSync).mockImplementation((command, args) => {
         if (command === 'npm' || command === 'npm.cmd') {
            expect(args).toEqual(['install']);
            expect(fs.existsSync(path.join(target, 'server/langium-config.json'))).toBe(true);
            return { pid: 1, output: [], stdout: '', stderr: '', status, signal, error };
         }
         return { pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null };
      });
      return { target, output };
   }

   it('installs after writing the scaffold in its directory and prints only the remaining steps', async () => {
      const { target, output } = setup();
      await runInitCommand([target, '--name', 'Example', '--install']);
      expect(spawnSync).toHaveBeenCalledWith(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], {
         cwd: target,
         stdio: 'inherit',
         shell: process.platform === 'win32'
      });
      expect(output.join('')).not.toContain('  npm install\n');
      expect(output.join('')).toContain('  npm run build');
   });

   it('keeps installation opt-in', async () => {
      const { target, output } = setup();
      await runInitCommand([target, '--name', 'Example']);
      expect(vi.mocked(spawnSync).mock.calls.some(([command]) => command === 'npm' || command === 'npm.cmd')).toBe(false);
      expect(output.join('')).toContain('  npm install\n');
   });

   it.each([
      ['exit code 1', 1, undefined, null],
      ['spawn ENOENT', 0, new Error('spawn ENOENT'), null],
      ['SIGTERM', 0, undefined, 'SIGTERM']
   ] as const)('keeps the files and reports %s on installation failure', async (reason, status, error, signal) => {
      const { target, output } = setup(status, error, signal);
      await expect(runInitCommand([target, '--name', 'Example', '--install'])).rejects.toThrow(reason);
      expect(fs.existsSync(path.join(target, 'package.json'))).toBe(true);
      expect(output.join('')).not.toContain('Next steps:');
   });

   it('rejects monorepo installation before writing files', async () => {
      const { target } = setup();
      await expect(runInitCommand([target, '--name', 'Example', '--monorepo', '--install'])).rejects.toThrow(
         '--install cannot be combined with --monorepo'
      );
      expect(fs.existsSync(target)).toBe(false);
      expect(spawnSync).not.toHaveBeenCalled();
   });

   it('does not install when the target is occupied', async () => {
      const { target } = setup();
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'existing.txt'), 'keep');
      await expect(runInitCommand([target, '--name', 'Example', '--install'])).rejects.toThrow('not empty');
      expect(spawnSync).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(target, 'existing.txt'), 'utf8')).toBe('keep');
   });
});
