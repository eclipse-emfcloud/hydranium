/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, SystemClock } from '@hydranium/protocol';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
   flushLogFileFallback,
   getLogFilePath,
   resolveLogFilePlaceholder,
   setLogFileSink,
   setLogFilePath,
   toLogFileWorkspaceToken
} from '../../../src/langium/diagnostics/logger.js';
import { installNodeLogFileSink } from '../../../src/node/log-file-sink.js';
import { LspLogger } from '../../../src/langium/diagnostics/lsp-logger.js';
import type { ServerSharedServices } from '../../../src/langium/module.js';

/**
 * Stub matching the bits of `ServerSharedServices` that `LspLogger.emit`
 * reads: `lsp.Connection` (left undefined so emit takes the console-fallback
 * branch — the file-tee runs regardless, which is what these tests cover) and
 * the `Clock` slot the timestamp is sourced from.
 */
function makeServicesStub(): ServerSharedServices {
   return { lsp: { Connection: undefined }, Clock: new SystemClock() } as unknown as ServerSharedServices;
}

describe('LspLogger file-tee', () => {
   const ENV_VAR = 'HYDRANIUM_TEST_LOG_FILE';
   let tmpDir: string;
   let originalEnv: string | undefined;
   const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

   beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'logger-test-'));
      originalEnv = process.env[ENV_VAR];
      delete process.env[ENV_VAR];
      // The file-tee's disk write goes through the injected sink, which a Node
      // host installs by importing `@hydranium/core/node`; install it here so
      // the tee actually writes.
      installNodeLogFileSink();
      setLogFilePath(undefined);
      // emit's no-connection fallback would otherwise leak into the test output.
      // In Node that fallback is `process.stderr`, not `console.*`; the console
      // spies stay because the browser branch is what they cover.
      for (const method of ['info', 'warn', 'error', 'debug', 'log'] as const) {
         consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
      }
      consoleSpies.push(vi.spyOn(process.stderr, 'write').mockImplementation(() => true));
   });

   afterEach(() => {
      setLogFilePath(undefined);
      setLogFileSink(undefined);
      if (originalEnv !== undefined) {
         process.env[ENV_VAR] = originalEnv;
      } else {
         delete process.env[ENV_VAR];
      }
      rmSync(tmpDir, { recursive: true, force: true });
      while (consoleSpies.length > 0) {
         consoleSpies.pop()?.mockRestore();
      }
   });

   describe('withUri renders workspace-relative paths', () => {
      function servicesWithWorkspace(wsRelativePath: (uri: unknown) => string): ServerSharedServices {
         return {
            lsp: { Connection: undefined },
            Clock: new SystemClock(),
            workspace: { WorkspaceManager: { wsRelativePath } }
         } as unknown as ServerSharedServices;
      }

      it('labels the derived logger via WorkspaceManager.wsRelativePath, not the full URI', () => {
         const logger = new LspLogger(servicesWithWorkspace(() => 'a/foo.a'));
         setLogFilePath(join(tmpDir, 'wsuri.log'));
         logger.withUri('file:///ws/a/foo.a').info('hello');
         const contents = readFileSync(join(tmpDir, 'wsuri.log'), 'utf8');
         expect(contents).toContain('[a/foo.a]');
         expect(contents).not.toContain('file:///ws/a/foo.a');
      });

      it('passes the uri through to wsRelativePath', () => {
         const seen: unknown[] = [];
         const logger = new LspLogger(
            servicesWithWorkspace(uri => {
               seen.push(uri);
               return 'rel';
            })
         );
         logger.withUri('file:///ws/x.a');
         expect(seen).toEqual(['file:///ws/x.a']);
      });
   });

   describe('setLogFilePath', () => {
      it('enables file-tee with a non-empty path', () => {
         const path = join(tmpDir, 'set.log');
         setLogFilePath(path);
         expect(getLogFilePath()).toBe(path);
      });

      it('disables file-tee when called with undefined', () => {
         setLogFilePath(join(tmpDir, 'set.log'));
         setLogFilePath(undefined);
         expect(getLogFilePath()).toBeUndefined();
      });

      it('treats an empty-string path as "disabled"', () => {
         setLogFilePath(join(tmpDir, 'set.log'));
         setLogFilePath('');
         expect(getLogFilePath()).toBeUndefined();
      });
   });

   describe('path placeholders', () => {
      it('buffers lines until {workspace} is resolved, then flushes to the expanded path', () => {
         setLogFilePath(join(tmpDir, '{workspace}.log'));
         const logger = new LspLogger(makeServicesStub());

         logger.info('before-resolve');
         // Workspace still unknown: nothing on disk yet, line held in the buffer.
         expect(existsSync(join(tmpDir, 'my-ws.log'))).toBe(false);

         resolveLogFilePlaceholder('workspace', 'my-ws');

         const contents = readFileSync(join(tmpDir, 'my-ws.log'), 'utf-8');
         expect(contents).toContain('before-resolve');
      });

      it('preserves emission order across the resolve boundary (buffered then direct)', () => {
         setLogFilePath(join(tmpDir, '{workspace}.log'));
         const logger = new LspLogger(makeServicesStub());

         logger.info('buffered-1');
         logger.info('buffered-2');
         resolveLogFilePlaceholder('workspace', 'ws');
         logger.info('direct-3');

         const lines = readFileSync(join(tmpDir, 'ws.log'), 'utf-8').trim().split('\n');
         expect(lines).toHaveLength(3);
         expect(lines[0]).toContain('buffered-1');
         expect(lines[1]).toContain('buffered-2');
         expect(lines[2]).toContain('direct-3');
      });

      it('creates the parent directory of the resolved target if missing', () => {
         // Mirrors the capture use case where the runner wipes the output dir
         // before the server (re)creates its log under it.
         const nested = join(tmpDir, 'deep', 'server-logs');
         setLogFilePath(join(nested, '{workspace}.log'));
         const logger = new LspLogger(makeServicesStub());

         logger.info('line');
         resolveLogFilePlaceholder('workspace', 'ws');

         expect(readFileSync(join(nested, 'ws.log'), 'utf-8')).toContain('line');
      });

      it('flushes buffered lines to a fallback file when the placeholder never resolves', () => {
         setLogFilePath(join(tmpDir, '{workspace}.log'));
         const logger = new LspLogger(makeServicesStub());

         logger.error('startup-failure');
         // Workspace never resolves (e.g. server crashed during startup).
         flushLogFileFallback();

         const logs = readdirSync(tmpDir).filter(file => file.endsWith('.log'));
         expect(logs).toHaveLength(1);
         expect(logs[0]).toContain('_startup');
         expect(readFileSync(join(tmpDir, logs[0]), 'utf-8')).toContain('startup-failure');
      });
   });

   describe('toLogFileWorkspaceToken', () => {
      it('returns the basename of a file URI', () => {
         expect(toLogFileWorkspaceToken('file:///tmp/cloud-ws-abc')).toBe('cloud-ws-abc');
      });

      it('returns the basename of a filesystem path, ignoring a trailing slash', () => {
         expect(toLogFileWorkspaceToken('/tmp/cloud-ws-xyz/')).toBe('cloud-ws-xyz');
      });

      it('replaces filename-unsafe characters so the token is path-safe', () => {
         expect(toLogFileWorkspaceToken('file:///tmp/My Project (1)')).toBe('My_Project__1_');
      });
   });

   describe('emit fan-out', () => {
      it('appends formatted lines to the configured file', () => {
         const path = join(tmpDir, 'append.log');
         setLogFilePath(path);
         const logger = new LspLogger(makeServicesStub(), { component: 'TestComp' });

         logger.info('hello world');

         const contents = readFileSync(path, 'utf-8');
         expect(contents).toMatch(/\[Info {2}- \d{2}:\d{2}:\d{2}\.\d{3}\] \[TestComp\] hello world\n$/);
      });

      it('preserves emission order across multiple lines', () => {
         const path = join(tmpDir, 'order.log');
         setLogFilePath(path);
         const logger = new LspLogger(makeServicesStub());

         logger.info('first');
         logger.error('second');
         logger.info('third');

         const lines = readFileSync(path, 'utf-8').trim().split('\n');
         expect(lines).toHaveLength(3);
         expect(lines[0]).toContain('first');
         expect(lines[1]).toContain('second');
         expect(lines[2]).toContain('third');
      });

      it('does not write when file-tee is disabled', () => {
         const path = join(tmpDir, 'disabled.log');
         // Note: not calling setLogFilePath.
         const logger = new LspLogger(makeServicesStub());

         logger.info('no-file');

         expect(existsSync(path)).toBe(false);
      });

      it('silently swallows write failures and does not throw', () => {
         // Point the tee at a path that is itself a directory, so the append
         // fails (EISDIR). A missing parent does not fail — the tee mkdirs it.
         const dirAsTarget = join(tmpDir, 'iam-a-dir');
         mkdirSync(dirAsTarget);
         setLogFilePath(dirAsTarget);
         const logger = new LspLogger(makeServicesStub());

         expect(() => logger.info('no-throw')).not.toThrow();
      });

      it('respects the active log threshold', () => {
         const path = join(tmpDir, 'threshold.log');
         setLogFilePath(path);
         const previousLevel = Logger.getLevel();
         Logger.setLevel('warn');
         try {
            const logger = new LspLogger(makeServicesStub());
            logger.info('below-threshold');
            logger.warn('at-threshold');
         } finally {
            Logger.setLevel(previousLevel);
         }

         const contents = readFileSync(path, 'utf-8');
         expect(contents).not.toContain('below-threshold');
         expect(contents).toContain('at-threshold');
      });
   });
});

/**
 * Where a log line goes when no LSP `Connection` is bound.
 *
 * This is a **protocol-integrity** property, not a formatting preference. A
 * data-server or LSP head launched over stdio carries JSON-RPC frames on
 * stdout, so a log line written there corrupts the stream — and `console.info`
 * / `console.debug` / `console.log` all write to stdout. The levels most likely
 * to be enabled for diagnosis are exactly the ones that would have done the
 * damage, which is why every level is asserted rather than a sample.
 */
describe('LspLogger console fallback (no LSP connection)', () => {
   let stderrWrites: string[];
   let stdoutWrites: string[];
   const spies: Array<ReturnType<typeof vi.spyOn>> = [];

   beforeEach(() => {
      stderrWrites = [];
      stdoutWrites = [];
      spies.push(
         vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
            stderrWrites.push(String(chunk));
            return true;
         })
      );
      spies.push(
         vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
            stdoutWrites.push(String(chunk));
            return true;
         })
      );
      // `console.*` ultimately reaches the stdout/stderr spies above, but spy on
      // it too so a regression that bypassed `writeStderr` is still captured
      // rather than escaping into the runner's own output.
      for (const method of ['info', 'warn', 'error', 'debug', 'log'] as const) {
         spies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
      }
   });

   afterEach(() => {
      while (spies.length > 0) {
         spies.pop()?.mockRestore();
      }
   });

   it('writes every level to stderr and nothing to stdout', () => {
      const previousLevel = Logger.getLevel();
      Logger.setLevel('trace');
      try {
         const logger = new LspLogger(makeServicesStub());
         logger.error('level-error');
         logger.warn('level-warn');
         logger.info('level-info');
         logger.debug('level-debug');
         logger.trace('level-trace');
      } finally {
         Logger.setLevel(previousLevel);
      }

      const onStderr = stderrWrites.join('');
      for (const marker of ['level-error', 'level-warn', 'level-info', 'level-debug', 'level-trace']) {
         expect(onStderr).toContain(marker);
      }
      // The load-bearing half: stdout is the protocol channel and must stay empty.
      expect(stdoutWrites.join('')).toBe('');
   });

   it('falls back to stderr when the LSP channel throws, instead of propagating', () => {
      // `RemoteConsole.send` throws `Connection is disposed` once the client has
      // gone. The framework's own unhandled-rejection handler logs through this
      // path, so propagating would crash the server while reporting an error —
      // and the lines arriving at that moment are the ones worth keeping.
      const services = {
         lsp: {
            Connection: {
               console: {
                  info: () => {
                     throw new Error('Connection is disposed.');
                  }
               }
            }
         },
         Clock: new SystemClock()
      } as unknown as ServerSharedServices;

      const logger = new LspLogger(services);
      expect(() => logger.info('after-teardown')).not.toThrow();
      expect(stderrWrites.join('')).toContain('after-teardown');
      expect(stdoutWrites.join('')).toBe('');
   });

   it('routes through the LSP connection instead when one is bound', () => {
      const logged: string[] = [];
      const services = {
         lsp: { Connection: { console: { info: (message: string) => logged.push(message) } } },
         Clock: new SystemClock()
      } as unknown as ServerSharedServices;

      new LspLogger(services).info('via-connection');

      expect(logged.join('')).toContain('via-connection');
      // Neither raw channel is touched once the framed LSP sink is available.
      expect(stderrWrites.join('')).toBe('');
      expect(stdoutWrites.join('')).toBe('');
   });
});
