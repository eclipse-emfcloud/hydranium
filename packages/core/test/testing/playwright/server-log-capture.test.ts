/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LOG_FILE_ENV, DEFAULT_LOG_LEVEL_ENV } from '@hydranium/protocol';
import {
   attachServerLog,
   captureServerLog,
   type ConsoleMessageLike,
   DEFAULT_BROWSER_LOG_LEVELS_ENV,
   DEFAULT_SERVER_LOG_ATTACH_ENV,
   DEFAULT_SERVER_LOG_DIR_ENV,
   forwardBrowserConsole,
   markServerLog,
   renameServerLogs,
   resolveBrowserConsoleLogPath,
   resolveServerLogPath,
   type ServerLogTestInfo,
   serverLogSpecName
} from '../../../src/testing/playwright/server-log-capture.js';

/**
 * Every write in this module sits inside a swallowing try/catch, so "did not
 * throw" is not evidence of a no-op — a stray write is just as quiet as no
 * write. The mock delegates to the real implementations and exists only so the
 * absence of a write is observable; nothing else in the file changes behaviour.
 */
vi.mock('node:fs', async importOriginal => {
   const actual = await importOriginal<typeof NodeFs>();
   return { ...actual, appendFileSync: vi.fn(actual.appendFileSync), writeFileSync: vi.fn(actual.writeFileSync) };
});

describe('captureServerLog', () => {
   // A resolved dir is published onto the env var, so every case here has to put
   // the original back or the next one inherits a directory it never configured.
   const originalDir = process.env[DEFAULT_SERVER_LOG_DIR_ENV];
   afterEach(() => {
      if (originalDir === undefined) {
         delete process.env[DEFAULT_SERVER_LOG_DIR_ENV];
      } else {
         process.env[DEFAULT_SERVER_LOG_DIR_ENV] = originalDir;
      }
   });

   it('sets the framework env var names and defaults the level to debug', () => {
      const previous = process.env[DEFAULT_LOG_LEVEL_ENV];
      delete process.env[DEFAULT_LOG_LEVEL_ENV];
      try {
         const { env } = captureServerLog({ dir: '/tmp/logs' });
         // `join`, not a literal: the capture builds a filesystem path, so the
         // separator is the platform's and a hardcoded `/` asserts the
         // separator rather than the template.
         expect(env[DEFAULT_LOG_FILE_ENV]).toBe(join('/tmp/logs', '{workspace}.log'));
         expect(env[DEFAULT_LOG_LEVEL_ENV]).toBe('debug');
      } finally {
         if (previous !== undefined) {
            process.env[DEFAULT_LOG_LEVEL_ENV] = previous;
         }
      }
   });

   it('honours an explicit level override', () => {
      const { env } = captureServerLog({ dir: '/tmp/logs', level: 'trace' });
      expect(env[DEFAULT_LOG_LEVEL_ENV]).toBe('trace');
   });

   it('respects a pre-set HYDRANIUM_LOG_LEVEL env when no explicit level is passed', () => {
      const previous = process.env[DEFAULT_LOG_LEVEL_ENV];
      process.env[DEFAULT_LOG_LEVEL_ENV] = 'info';
      try {
         expect(captureServerLog({ dir: '/tmp/logs' }).env[DEFAULT_LOG_LEVEL_ENV]).toBe('info');
         // An explicit option still wins over the env.
         expect(captureServerLog({ dir: '/tmp/logs', level: 'trace' }).env[DEFAULT_LOG_LEVEL_ENV]).toBe('trace');
      } finally {
         if (previous !== undefined) {
            process.env[DEFAULT_LOG_LEVEL_ENV] = previous;
         } else {
            delete process.env[DEFAULT_LOG_LEVEL_ENV];
         }
      }
   });

   it('returns an empty env (inert) when no dir is configured', () => {
      const previous = process.env[DEFAULT_SERVER_LOG_DIR_ENV];
      delete process.env[DEFAULT_SERVER_LOG_DIR_ENV];
      try {
         expect(captureServerLog().env).toEqual({});
      } finally {
         if (previous !== undefined) {
            process.env[DEFAULT_SERVER_LOG_DIR_ENV] = previous;
         }
      }
   });

   it('publishes an explicit dir so the runner-side halves capture into it', () => {
      // The returned env reaches the server child only, so asserting on it cannot
      // witness this: what the option has to move is where `markServerLog` writes.
      // It is called here with NO options, exactly as `serverLogFixtures` calls it.
      delete process.env[DEFAULT_SERVER_LOG_DIR_ENV];
      const dir = mkdtempSync(join(tmpdir(), 'srvlog-publish-'));
      try {
         captureServerLog({ dir });
         markServerLog({ title: 'a marked test', attach: async () => undefined }, '/ws/one');
         const marker = resolveServerLogPath('/ws/one', { dir });
         if (marker === undefined) {
            throw new Error('resolveServerLogPath returned no path for an explicit dir');
         }
         expect(existsSync(marker)).toBe(true);
         expect(readFileSync(marker, 'utf-8')).toContain('START: a marked test');
      } finally {
         rmSync(dir, { recursive: true, force: true });
      }
   });

   it('reads the dir from the default env var when not passed', () => {
      const previous = process.env[DEFAULT_SERVER_LOG_DIR_ENV];
      process.env[DEFAULT_SERVER_LOG_DIR_ENV] = '/tmp/from-env';
      try {
         expect(captureServerLog().env[DEFAULT_LOG_FILE_ENV]).toBe(join('/tmp/from-env', '{workspace}.log'));
      } finally {
         if (previous !== undefined) {
            process.env[DEFAULT_SERVER_LOG_DIR_ENV] = previous;
         } else {
            delete process.env[DEFAULT_SERVER_LOG_DIR_ENV];
         }
      }
   });
});

describe('serverLogSpecName', () => {
   it('derives a sanitized name from the spec path below tests/', () => {
      expect(serverLogSpecName('/repo/e2e/src/tests/suite-one/group-two/case-three.spec.ts')).toBe('suite-one_group-two_case-three');
   });

   it('strips the .spec suffix for every module extension a spec file can carry', () => {
      // A `.tsx?`-only strip leaves the extension inside the log file name, and
      // an ESM Playwright project — which is what a Theia host forces — names
      // its specs `.spec.mts`.
      expect(serverLogSpecName('/repo/test/e2e/case-three.spec.mts')).toBe('case-three');
      expect(serverLogSpecName('/repo/test/e2e/case-three.spec.cts')).toBe('case-three');
   });

   it('falls back to the basename when there is no tests/ segment', () => {
      expect(serverLogSpecName('/some/where/foo.spec.ts')).toBe('foo');
   });
});

describe('renameServerLogs', () => {
   let dir: string;
   beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'srvlog-rename-'));
   });
   afterEach(() => rmSync(dir, { recursive: true, force: true }));

   it('renames each <token>.log to its sidecar name and removes the sidecar', () => {
      writeFileSync(join(dir, 'cloud-ws-abc.log'), 'A');
      writeFileSync(join(dir, 'cloud-ws-abc.spec'), 'attributes-spec');

      renameServerLogs(dir);

      expect(existsSync(join(dir, 'cloud-ws-abc.log'))).toBe(false);
      expect(existsSync(join(dir, 'cloud-ws-abc.spec'))).toBe(false);
      expect(readFileSync(join(dir, 'attributes-spec.log'), 'utf-8')).toBe('A');
   });

   it('suffixes on a name collision (a spec that used multiple workspaces)', () => {
      writeFileSync(join(dir, 'cloud-ws-1.log'), 'one');
      writeFileSync(join(dir, 'cloud-ws-1.spec'), 'dual');
      writeFileSync(join(dir, 'cloud-ws-2.log'), 'two');
      writeFileSync(join(dir, 'cloud-ws-2.spec'), 'dual');

      renameServerLogs(dir);

      const logs = readdirSync(dir)
         .filter(f => f.endsWith('.log'))
         .sort();
      expect(logs).toEqual(['dual-2.log', 'dual.log']);
   });

   it('leaves a token log without a sidecar untouched', () => {
      writeFileSync(join(dir, 'orphan.log'), 'x');
      expect(() => renameServerLogs(dir)).not.toThrow();
      expect(existsSync(join(dir, 'orphan.log'))).toBe(true);
   });

   it('renames the browser-console log alongside the backend log under the same base name', () => {
      writeFileSync(join(dir, 'cloud-ws-abc.log'), 'backend');
      writeFileSync(join(dir, 'cloud-ws-abc.browser.log'), 'browser');
      writeFileSync(join(dir, 'cloud-ws-abc.spec'), 'attributes-spec');

      renameServerLogs(dir);

      expect(existsSync(join(dir, 'cloud-ws-abc.browser.log'))).toBe(false);
      expect(readFileSync(join(dir, 'attributes-spec.log'), 'utf-8')).toBe('backend');
      expect(readFileSync(join(dir, 'attributes-spec.browser.log'), 'utf-8')).toBe('browser');
   });
});

describe('attachServerLog', () => {
   let dir: string;
   let attached: Array<{ name: string; options: { path: string; contentType: string } }>;

   beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'srvlog-'));
      attached = [];
   });
   afterEach(() => rmSync(dir, { recursive: true, force: true }));

   function fakeTestInfo(title: string, status: string, expectedStatus = 'passed'): ServerLogTestInfo {
      return {
         title,
         status,
         expectedStatus,
         attach: async (name, options) => {
            attached.push({ name, options });
         }
      };
   }

   it('appends an end-of-test boundary marker to the workspace log', async () => {
      writeFileSync(join(dir, 'cloud-ws-abc.log'), 'server output\n');

      await attachServerLog(fakeTestInfo('does a thing', 'passed'), '/tmp/cloud-ws-abc', { dir });

      const contents = readFileSync(join(dir, 'cloud-ws-abc.log'), 'utf-8');
      expect(contents).toContain('server output');
      expect(contents).toMatch(/=+ END: does a thing — passed =+/);
   });

   it('markServerLog appends a start marker before the test runs', () => {
      writeFileSync(join(dir, 'cloud-ws-abc.log'), 'preamble\n');

      markServerLog({ title: 'does a thing' } as ServerLogTestInfo, '/tmp/cloud-ws-abc', { dir });

      const contents = readFileSync(join(dir, 'cloud-ws-abc.log'), 'utf-8');
      expect(contents).toMatch(/=+ START: does a thing =+/);
   });

   it('markServerLog writes nothing when no capture dir is configured', () => {
      const previous = process.env[DEFAULT_SERVER_LOG_DIR_ENV];
      delete process.env[DEFAULT_SERVER_LOG_DIR_ENV];
      vi.mocked(appendFileSync).mockClear();
      vi.mocked(writeFileSync).mockClear();
      try {
         // `file` is supplied so the `.spec` sidecar branch is reached too.
         markServerLog({ title: 't', file: '/repo/test/e2e/some.spec.ts' } as ServerLogTestInfo, '/tmp/cloud-ws-abc');

         // Absence of a WRITE, not absence of a throw: a `dir ?? tmpdir()`
         // fallback would scatter a stray log into the OS temp dir and the
         // swallowing catch would keep it silent.
         expect(vi.mocked(appendFileSync)).not.toHaveBeenCalled();
         expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
      } finally {
         if (previous !== undefined) {
            process.env[DEFAULT_SERVER_LOG_DIR_ENV] = previous;
         }
      }
   });

   it('attaches the log on failure', async () => {
      writeFileSync(join(dir, 'cloud-ws-abc.log'), 'server output\n');

      await attachServerLog(fakeTestInfo('broken test', 'failed'), '/tmp/cloud-ws-abc', { dir });

      expect(attached).toHaveLength(1);
      expect(attached[0].name).toBe('server-log');
      expect(attached[0].options.path).toBe(join(dir, 'cloud-ws-abc.log'));
   });

   it('does not attach on a passing test', async () => {
      writeFileSync(join(dir, 'cloud-ws-abc.log'), 'server output\n');

      await attachServerLog(fakeTestInfo('ok test', 'passed'), '/tmp/cloud-ws-abc', { dir });

      expect(attached).toHaveLength(0);
   });

   it('attaches on a passing test when attachOn is "always"', async () => {
      writeFileSync(join(dir, 'cloud-ws-abc.log'), 'server output\n');

      await attachServerLog(fakeTestInfo('ok test', 'passed'), '/tmp/cloud-ws-abc', { dir, attachOn: 'always' });

      expect(attached).toHaveLength(1);
   });

   it('never attaches when attachOn is "never", even on failure', async () => {
      writeFileSync(join(dir, 'cloud-ws-abc.log'), 'server output\n');

      await attachServerLog(fakeTestInfo('broken', 'failed'), '/tmp/cloud-ws-abc', { dir, attachOn: 'never' });

      expect(attached).toHaveLength(0);
   });

   it('takes the attachOn default from HYDRANIUM_SERVER_LOG_ATTACH when not passed', async () => {
      writeFileSync(join(dir, 'cloud-ws-abc.log'), 'server output\n');
      const previous = process.env[DEFAULT_SERVER_LOG_ATTACH_ENV];
      process.env[DEFAULT_SERVER_LOG_ATTACH_ENV] = 'always';
      try {
         await attachServerLog(fakeTestInfo('ok test', 'passed'), '/tmp/cloud-ws-abc', { dir });
         expect(attached).toHaveLength(1);
      } finally {
         if (previous !== undefined) {
            process.env[DEFAULT_SERVER_LOG_ATTACH_ENV] = previous;
         } else {
            delete process.env[DEFAULT_SERVER_LOG_ATTACH_ENV];
         }
      }
   });

   it('lets an explicit attachOn option win over the env default', async () => {
      writeFileSync(join(dir, 'cloud-ws-abc.log'), 'server output\n');
      const previous = process.env[DEFAULT_SERVER_LOG_ATTACH_ENV];
      process.env[DEFAULT_SERVER_LOG_ATTACH_ENV] = 'always';
      try {
         await attachServerLog(fakeTestInfo('ok test', 'passed'), '/tmp/cloud-ws-abc', { dir, attachOn: 'never' });
         expect(attached).toHaveLength(0);
      } finally {
         if (previous !== undefined) {
            process.env[DEFAULT_SERVER_LOG_ATTACH_ENV] = previous;
         } else {
            delete process.env[DEFAULT_SERVER_LOG_ATTACH_ENV];
         }
      }
   });

   it('is a no-op when no capture dir is configured', async () => {
      const previous = process.env[DEFAULT_SERVER_LOG_DIR_ENV];
      delete process.env[DEFAULT_SERVER_LOG_DIR_ENV];
      try {
         await attachServerLog(fakeTestInfo('t', 'failed'), '/tmp/cloud-ws-abc');
         expect(attached).toHaveLength(0);
      } finally {
         if (previous !== undefined) {
            process.env[DEFAULT_SERVER_LOG_DIR_ENV] = previous;
         }
      }
   });
});

describe('forwardBrowserConsole', () => {
   let dir: string;

   beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'srvlog-console-'));
   });
   afterEach(() => rmSync(dir, { recursive: true, force: true }));

   function fakePage(): {
      onCalled: boolean;
      emit(type: string, text: string): void;
      on(event: 'console', listener: (message: ConsoleMessageLike) => void): void;
   } {
      let listener: ((message: ConsoleMessageLike) => void) | undefined;
      return {
         onCalled: false,
         on(_event, handler) {
            this.onCalled = true;
            listener = handler;
         },
         emit(type, text) {
            listener?.({ type: () => type, text: () => text });
         }
      };
   }

   it('forwards only error and warning into a separate browser-console log, not server.log', () => {
      const page = fakePage();
      forwardBrowserConsole(page, '/tmp/cloud-ws-abc', { dir });
      page.emit('error', 'boom');
      page.emit('warning', 'careful');
      page.emit('info', 'noise');
      page.emit('log', 'chatter');

      const contents = readFileSync(join(dir, 'cloud-ws-abc.browser.log'), 'utf-8');
      expect(contents).toContain('[browser] [error] boom');
      expect(contents).toContain('[browser] [warning] careful');
      expect(contents).not.toContain('noise');
      expect(contents).not.toContain('chatter');
      // The backend server log stays untouched — the two streams are separate.
      expect(existsSync(join(dir, 'cloud-ws-abc.log'))).toBe(false);
   });

   it('honours an explicit levels option (forwarding a level the default set omits)', () => {
      const page = fakePage();
      forwardBrowserConsole(page, '/tmp/cloud-ws-abc', { dir, levels: ['error', 'info'] });
      page.emit('error', 'boom');
      page.emit('info', 'detail');
      page.emit('warning', 'dropped');

      const contents = readFileSync(join(dir, 'cloud-ws-abc.browser.log'), 'utf-8');
      expect(contents).toContain('[browser] [error] boom');
      expect(contents).toContain('[browser] [info] detail');
      expect(contents).not.toContain('dropped');
   });

   it('reads the forwarded levels from HYDRANIUM_BROWSER_LOG_LEVELS when no option is passed', () => {
      const previous = process.env[DEFAULT_BROWSER_LOG_LEVELS_ENV];
      process.env[DEFAULT_BROWSER_LOG_LEVELS_ENV] = 'error';
      try {
         const page = fakePage();
         forwardBrowserConsole(page, '/tmp/cloud-ws-abc', { dir });
         page.emit('error', 'boom');
         page.emit('warning', 'dropped');
         const contents = readFileSync(join(dir, 'cloud-ws-abc.browser.log'), 'utf-8');
         expect(contents).toContain('[browser] [error] boom');
         expect(contents).not.toContain('dropped');
      } finally {
         if (previous !== undefined) {
            process.env[DEFAULT_BROWSER_LOG_LEVELS_ENV] = previous;
         } else {
            delete process.env[DEFAULT_BROWSER_LOG_LEVELS_ENV];
         }
      }
   });

   it('does not attach a listener when no capture dir is configured', () => {
      const previous = process.env[DEFAULT_SERVER_LOG_DIR_ENV];
      delete process.env[DEFAULT_SERVER_LOG_DIR_ENV];
      try {
         const page = fakePage();
         forwardBrowserConsole(page, '/tmp/cloud-ws-abc');
         expect(page.onCalled).toBe(false);
      } finally {
         if (previous !== undefined) {
            process.env[DEFAULT_SERVER_LOG_DIR_ENV] = previous;
         }
      }
   });
});

describe('resolveServerLogPath', () => {
   it('resolves the per-workspace <token>.log under the given capture dir', () => {
      expect(resolveServerLogPath('/tmp/cloud-ws-abc', { dir: '/logs' })).toBe(join('/logs', 'cloud-ws-abc.log'));
   });

   it('returns undefined when no capture dir is configured', () => {
      const previous = process.env[DEFAULT_SERVER_LOG_DIR_ENV];
      delete process.env[DEFAULT_SERVER_LOG_DIR_ENV];
      try {
         expect(resolveServerLogPath('/tmp/cloud-ws-abc')).toBeUndefined();
      } finally {
         if (previous !== undefined) {
            process.env[DEFAULT_SERVER_LOG_DIR_ENV] = previous;
         }
      }
   });
});

describe('resolveBrowserConsoleLogPath', () => {
   it('resolves the per-workspace <token>.browser.log under the given capture dir', () => {
      expect(resolveBrowserConsoleLogPath('/tmp/cloud-ws-abc', { dir: '/logs' })).toBe(join('/logs', 'cloud-ws-abc.browser.log'));
   });

   it('returns undefined when no capture dir is configured', () => {
      const previous = process.env[DEFAULT_SERVER_LOG_DIR_ENV];
      delete process.env[DEFAULT_SERVER_LOG_DIR_ENV];
      try {
         expect(resolveBrowserConsoleLogPath('/tmp/cloud-ws-abc')).toBeUndefined();
      } finally {
         if (previous !== undefined) {
            process.env[DEFAULT_SERVER_LOG_DIR_ENV] = previous;
         }
      }
   });
});
