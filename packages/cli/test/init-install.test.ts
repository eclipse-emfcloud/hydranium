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
import * as initPrompt from '../src/commands/init-prompt.js';

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
            if (args?.[0] === 'config') {
               expect(args).toEqual(['config', 'get', 'globalconfig', '--workspaces=false']);
               return { pid: 1, output: [], stdout: '/global npm/etc/npmrc\n', stderr: '', status: 0, signal: null };
            }
            expect(args).toEqual(['--prefix', '.', 'install']);
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
      expect(spawnSync).toHaveBeenCalledWith(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', '.', 'install'], {
         cwd: target,
         stdio: 'inherit',
         shell: process.platform === 'win32',
         env: { ...process.env, npm_config_globalconfig: '/global npm/etc/npmrc' }
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
      const result = runInitCommand([target, '--name', 'Example', '--install']);
      await expect(result).rejects.toThrow(reason);
      await expect(result).rejects.toThrow('Run npm --prefix . install there to retry.');
      await expect(result).rejects.toThrow('Set npm_config_globalconfig to /global npm/etc/npmrc');
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

   it('rejects incompatible flags before opening the wizard on a terminal', async () => {
      const { target } = setup();
      const prompt = vi.spyOn(initPrompt, 'createClackPrompt').mockRejectedValue(new Error('Wizard started'));
      const streams = [process.stdin, process.stdout];
      const descriptors = streams.map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
      try {
         for (const stream of streams) {
            Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
         }
         await expect(runInitCommand([target, '--monorepo', '--install'])).rejects.toThrow('--install cannot be combined with --monorepo');
         expect(prompt).not.toHaveBeenCalled();
         expect(fs.existsSync(target)).toBe(false);
         expect(spawnSync).not.toHaveBeenCalled();
      } finally {
         streams.forEach((stream, index) => {
            const descriptor = descriptors[index];
            if (descriptor) {
               Object.defineProperty(stream, 'isTTY', descriptor);
            } else {
               Reflect.deleteProperty(stream, 'isTTY');
            }
         });
      }
   });

   it('does not install when the target is occupied', async () => {
      const { target } = setup();
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'existing.txt'), 'keep');
      await expect(runInitCommand([target, '--name', 'Example', '--install'])).rejects.toThrow('not empty');
      expect(spawnSync).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(target, 'existing.txt'), 'utf8')).toBe('keep');
   });

   it('keeps the scaffold and stops when npm cannot report its global configuration', async () => {
      const { target } = setup();
      const original = vi.mocked(spawnSync).getMockImplementation()!;
      vi.mocked(spawnSync).mockImplementation((command, args, options) => {
         if (args?.[0] === 'config') {
            return { pid: 1, output: [], stdout: '', stderr: '', status: 1, signal: null };
         }
         return original(command, args, options);
      });
      await expect(runInitCommand([target, '--name', 'Example', '--install'])).rejects.toThrow('Could not read npm global configuration');
      expect(fs.existsSync(path.join(target, 'package.json'))).toBe(true);
      expect(vi.mocked(spawnSync).mock.calls.some(([, args]) => args?.includes('install'))).toBe(false);
   });
});
