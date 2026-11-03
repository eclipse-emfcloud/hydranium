/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { execFile, spawnSync } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInitCommand } from '../src/commands/init-args.js';
import * as initPrompt from '../src/commands/init-prompt.js';

vi.mock('node:child_process', async importOriginal => ({
   ...(await importOriginal<typeof ChildProcess>()),
   spawnSync: vi.fn()
}));

const directories: string[] = [];
afterEach(() => {
   vi.restoreAllMocks();
   vi.unstubAllEnvs();
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
      const globalconfig = path.join(root, 'npm configuration', 'npmrc');
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
               return { pid: 1, output: [], stdout: `${globalconfig}\n`, stderr: '', status: 0, signal: null };
            }
            expect(args).toEqual(['--prefix', '.', 'install']);
            expect(fs.existsSync(path.join(target, 'server/langium-config.json'))).toBe(true);
            return { pid: 1, output: [], stdout: '', stderr: '', status, signal, error };
         }
         return { pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null };
      });
      return { target, output, globalconfig };
   }

   it('installs after writing the scaffold in its directory and prints only the remaining steps', async () => {
      const { target, output, globalconfig } = setup();
      await runInitCommand([target, '--name', 'Example', '--install']);
      expect(spawnSync).toHaveBeenCalledWith(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', '.', 'install'], {
         cwd: target,
         stdio: 'inherit',
         env: expect.objectContaining({ npm_config_globalconfig: globalconfig }),
         shell: process.platform === 'win32'
      });
      expect(output.join('')).not.toContain('  npm install\n');
      expect(output.join('')).toContain('  npm run build');
   });

   it('resolves global configuration before applying the scaffold prefix and preserves the child environment', async () => {
      const { target, globalconfig } = setup();
      vi.stubEnv('NPM_CONFIG_GLOBALCONFIG', '/inherited/npmrc');
      vi.stubEnv('npm_config_globalconfig', '/inherited/lowercase/npmrc');
      vi.stubEnv('HTTPS_PROXY', 'http://proxy.invalid:8080');
      await runInitCommand([target, '--name', 'Example', '--install']);
      const calls = vi.mocked(spawnSync).mock.calls.filter(([command]) => command === 'npm' || command === 'npm.cmd');
      expect(calls.map(([, args]) => args)).toEqual([
         ['config', 'get', 'globalconfig', '--workspaces=false'],
         ['--prefix', '.', 'install']
      ]);
      expect(calls[0][2]).toMatchObject({ cwd: target, encoding: 'utf8' });
      expect(calls[1][2]?.env).toMatchObject({ npm_config_globalconfig: globalconfig, HTTPS_PROXY: 'http://proxy.invalid:8080' });
      expect(Object.keys(calls[1][2]?.env ?? {}).filter(key => key.toLowerCase() === 'npm_config_globalconfig')).toEqual([
         'npm_config_globalconfig'
      ]);
   });

   it('keeps the global registry setting readable by real npm under the scaffold prefix', async () => {
      const { target, globalconfig } = setup();
      fs.mkdirSync(path.dirname(globalconfig), { recursive: true });
      fs.writeFileSync(globalconfig, 'registry=https://global-registry.invalid/\n');
      await runInitCommand([target, '--name', 'Example', '--install']);
      const install = vi.mocked(spawnSync).mock.calls.find(([, args]) => args?.[0] === '--prefix');
      expect(install?.[2]?.env).toBeDefined();
      const env = Object.fromEntries(
         Object.entries(install?.[2]?.env ?? process.env).filter(([key]) => key.toLowerCase() !== 'npm_config_registry')
      );
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const args = ['--prefix', '.', 'config', 'get', 'registry', '--workspaces=false'];
      const retained = await promisify(execFile)(npm, args, { cwd: target, env, shell: process.platform === 'win32' });
      expect(retained.stdout.trim()).toBe('https://global-registry.invalid/');
      delete env.npm_config_globalconfig;
      const lost = await promisify(execFile)(npm, args, { cwd: target, env, shell: process.platform === 'win32' });
      expect(lost.stdout.trim()).not.toBe('https://global-registry.invalid/');
   });

   it.each(['failure', 'empty'] as const)('keeps the scaffold without installing after configuration lookup returns %s', async outcome => {
      const { target } = setup();
      const original = vi.mocked(spawnSync).getMockImplementation()!;
      vi.mocked(spawnSync).mockImplementation((command, args, options) =>
         args?.[0] === 'config'
            ? { pid: 1, output: [], stdout: '', stderr: '', status: outcome === 'failure' ? 1 : 0, signal: null }
            : original(command, args, options)
      );
      await expect(runInitCommand([target, '--name', 'Example', '--install'])).rejects.toThrow('Could not read npm global configuration');
      expect(fs.existsSync(path.join(target, 'server/package.json'))).toBe(true);
      expect(vi.mocked(spawnSync).mock.calls.some(([, args]) => args?.[0] === '--prefix')).toBe(false);
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
      const { target, output, globalconfig } = setup(status, error, signal);
      const result = runInitCommand([target, '--name', 'Example', '--install']);
      await expect(result).rejects.toThrow(reason);
      await expect(result).rejects.toThrow('Run npm --prefix . install there to retry.');
      await expect(result).rejects.toThrow(`Set npm_config_globalconfig to ${globalconfig}`);
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
