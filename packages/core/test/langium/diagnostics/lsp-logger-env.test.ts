/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOG_FILE_ENV, DEFAULT_LOG_FILE_LEVEL_ENV, DEFAULT_LOG_LEVEL_ENV, Logger, SystemClock } from '@hydranium/protocol';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { setLogFilePath, setLogFileSink } from '../../../src/langium/diagnostics/logger.js';
import { installNodeLogFileSink } from '../../../src/node/log-file-sink.js';
import { installConsoleTee, setConsoleFormat } from '../../../src/langium/diagnostics/console-tee.js';
import { LspLogger } from '../../../src/langium/diagnostics/lsp-logger.js';
import type { ServerSharedServices } from '../../../src/langium/module.js';

// Its own file because `LspLogger` applies the env baseline once per module
// instance: any earlier construction in the same file would already have read it.
describe('the first LspLogger of a module', () => {
   const tmpDir = mkdtempSync(join(tmpdir(), 'logger-env-test-'));
   const names = [DEFAULT_LOG_FILE_ENV, DEFAULT_LOG_FILE_LEVEL_ENV, DEFAULT_LOG_LEVEL_ENV];
   const previous = names.map(name => process.env[name]);
   const entryLevel = Logger.getLevel();
   // Where the console sent a line before the logger existed, as
   // `vscode-languageserver`'s stdio patch does; spied first so the logger wraps it.
   const passedOn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
   const quiet = [
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined)
   ];

   afterAll(() => {
      // Restoring the originals also drops the logger's wrappers, so nothing outlives the file.
      passedOn.mockRestore();
      quiet.forEach(spy => spy.mockRestore());
      names.forEach((name, i) => {
         if (previous[i] === undefined) {
            delete process.env[name];
         } else {
            process.env[name] = previous[i];
         }
      });
      Logger.setLevel(entryLevel);
      setLogFilePath(undefined);
      setLogFileSink(undefined);
      rmSync(tmpDir, { recursive: true, force: true });
   });

   const path = join(tmpDir, 'server.log');
   let logger: LspLogger;

   function makeServices(): ServerSharedServices {
      return { lsp: { Connection: undefined }, Clock: new SystemClock() } as unknown as ServerSharedServices;
   }

   /** The services of the first logger, which installs the console tee. */
   const firstServices = makeServices();

   function linesMatching(pattern: RegExp): number {
      return readFileSync(path, 'utf-8').match(pattern)?.length ?? 0;
   }

   beforeAll(() => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      installNodeLogFileSink();
      process.env[DEFAULT_LOG_FILE_ENV] = path;
      process.env[DEFAULT_LOG_FILE_LEVEL_ENV] = 'debug';
      process.env[DEFAULT_LOG_LEVEL_ENV] = 'debug';
      Logger.setLevel('info');
      logger = new LspLogger(firstServices, { logThreshold: 'info' });
   });

   describe('the HYDRANIUM_LOG_FILE_LEVEL baseline', () => {
      it('keeps the file at its own level after the setting applies', () => {
         logger.debug('after-setting');

         const contents = readFileSync(path, 'utf-8');
         expect(contents).toContain(`Log file level debug (${DEFAULT_LOG_FILE_LEVEL_ENV})`);
         expect(contents).toContain('Log level debug → info (setting)');
         expect(contents).toContain('after-setting');
         expect(Logger.getLevel()).toBe('info');
      });
   });

   describe('console tee', () => {
      it('writes console lines to the file at their level and still passes them on', () => {
         console.error('An error occurred during validation:', new Error('boom'));

         const contents = readFileSync(path, 'utf-8');
         expect(contents).toMatch(/^\[Error - [\d:.]+\] \[console\] An error occurred during validation: Error: boom$/m);
         expect(passedOn).toHaveBeenCalledWith('An error occurred during validation:', expect.any(Error));
      });

      it('labels each console method with its own level, and console.log as Log', () => {
         console.warn('warn-line');
         console.info('info-line');
         console.log('log-line');
         console.debug('debug-line');

         const contents = readFileSync(path, 'utf-8');
         expect(contents).toMatch(/^\[Warn {2}- [\d:.]+\] \[console\] warn-line$/m);
         expect(contents).toMatch(/^\[Info {2}- [\d:.]+\] \[console\] info-line$/m);
         expect(contents).toMatch(/^\[Log {3}- [\d:.]+\] \[console\] log-line$/m);
         expect(contents).toMatch(/^\[Debug - [\d:.]+\] \[console\] debug-line$/m);
      });

      it('gates each console line on the file threshold at its own level', () => {
         Logger.setFileLevel('warn');
         try {
            console.warn('warn-at-warn');
            console.info('info-at-warn');
         } finally {
            Logger.setFileLevel('debug');
         }

         expect(linesMatching(/\[console\] warn-at-warn$/gm)).toBe(1);
         expect(linesMatching(/info-at-warn/gm)).toBe(0);
      });

      it("writes vscode-languageserver's failed log send at error, since it carries no reason that would mark it teardown", () => {
         console.error('Sending log message failed');

         expect(readFileSync(path, 'utf-8')).toMatch(/^\[Error - [\d:.]+\] \[console\] Sending log message failed$/m);
      });

      it('passes on and logs a cyclic value that String cannot render', () => {
         // No prototype, so `String` throws for it as a cause; as an argument it renders as bounded JSON.
         const unformattable: Record<string, unknown> = Object.create(null);
         unformattable.self = unformattable;

         const withUnformattableCause = new Error('wrapped', { cause: unformattable });

         expect(() => console.error('unformattable-console', unformattable)).not.toThrow();
         expect(() => logger.error('unformattable-logger', unformattable)).not.toThrow();
         expect(() => logger.error('unformattable-cause', withUnformattableCause)).not.toThrow();
         expect(passedOn).toHaveBeenCalledWith('unformattable-console', unformattable);
         const contents = readFileSync(path, 'utf-8');
         expect(contents).toMatch(/\[console\] unformattable-console <ref \*1> \[Object: null prototype\] \{ self: \[Circular \*1\] \}$/m);
         expect(contents).toMatch(/unformattable-logger \{"self":"\[Circular\]"\}$/m);
         expect(contents).toMatch(/unformattable-cause Error: wrapped$/m);
         expect(contents).toMatch(/^Caused by: \[object Object\]$/m);
      });

      it('renders every object argument on the one line', () => {
         logger.error('two-args-logger', { first: 1 }, { second: [2] });
         expect(readFileSync(path, 'utf-8')).toMatch(/two-args-logger \{"first":1\} \{"second":\[2\]\}$/m);
      });

      it('logs a value whose JSON is nothing rather than dropping it', () => {
         logger.error('no-json-logger', { toJSON: () => undefined });
         expect(readFileSync(path, 'utf-8')).toMatch(/no-json-logger \[object Object\]$/m);
      });

      it('passes on and logs a revoked proxy, on which even instanceof throws', () => {
         const { proxy, revoke } = Proxy.revocable({}, {});
         revoke();

         expect(() => console.error('revoked-console', proxy)).not.toThrow();
         expect(() => logger.error('revoked-logger', proxy)).not.toThrow();
         // By identity: a deep equality check would itself trip the revoked proxy.
         expect(passedOn.mock.calls.some(([message, arg]) => message === 'revoked-console' && arg === proxy)).toBe(true);
         const contents = readFileSync(path, 'utf-8');
         expect(contents).toMatch(/\[console\] revoked-console <Revoked Proxy>$/m);
         expect(contents).toMatch(/revoked-logger \[object\]$/m);
      });

      it.each(['ConfigurationProvider', 'WorkspaceManager'])(
         "writes Langium's failed %s start at debug where its connection has gone, and at error otherwise",
         service => {
            console.error(`Error in ${service} initialization:`, new Error('Pending response rejected since connection got disposed'));
            console.error(`Error in ${service} initialization:`, new Error('start blew up'));

            const contents = readFileSync(path, 'utf-8');
            expect(contents).toMatch(
               new RegExp(
                  `^\\[Debug - [\\d:.]+\\] \\[console\\] Error in ${service} initialization: Error: Pending response rejected since connection got disposed$`,
                  'm'
               )
            );
            expect(contents).toMatch(
               new RegExp(`^\\[Error - [\\d:.]+\\] \\[console\\] Error in ${service} initialization: Error: start blew up$`, 'm')
            );
         }
      );

      it("writes Langium's failed start at error when its error is a revoked proxy", () => {
         const { proxy, revoke } = Proxy.revocable({}, {});
         revoke();

         console.error('Error in WorkspaceManager initialization:', proxy);

         expect(readFileSync(path, 'utf-8')).toMatch(
            /^\[Error - [\d:.]+\] \[console\] Error in WorkspaceManager initialization: <Revoked Proxy>$/m
         );
      });

      it('writes a console line as the console prints it, running no ordinary getter or proxy trap of an inspected value', () => {
         // As a DI container is, whose traps build the service they are asked about.
         const trap = vi.fn(() => undefined);
         const container = new Proxy({}, { get: trap, ownKeys: () => [], getOwnPropertyDescriptor: trap });
         const getter = vi.fn(() => 'read');
         const withGetter = Object.defineProperty({}, 'lazy', { get: getter, enumerable: true });

         console.log('%d docs', 3, container, withGetter);

         expect(linesMatching(/^\[Log {3}- [\d:.]+\] \[console\] 3 docs \{\} \{ lazy: \[Getter\] \}$/gm)).toBe(1);
         expect(trap).not.toHaveBeenCalled();
         expect(getter).not.toHaveBeenCalled();
      });

      it('writes a console line by its description where the console format throws', () => {
         const throwingStack = new Error('readable');
         Object.defineProperty(throwingStack, 'stack', {
            get: () => {
               throw new Error('locked');
            }
         });

         // A throwing renderer, since whether `util.format` throws on such an error depends on the Node release.
         setConsoleFormat(() => {
            throw new Error('unrenderable');
         });
         try {
            console.error('stack-throws', throwingStack);
         } finally {
            setConsoleFormat(format);
         }

         expect(linesMatching(/^\[Error - [\d:.]+\] \[console\] stack-throws readable$/gm)).toBe(1);
      });

      it('leaves the console alone for a later logger, a child included', () => {
         const unwrapped = vi.fn();
         const wrapped = console.warn;
         console.warn = unwrapped;
         try {
            new LspLogger(makeServices()).for('child');
            expect(console.warn).toBe(unwrapped);
         } finally {
            console.warn = wrapped;
         }
      });

      it('wraps a method a later connection replaced when installed again, and a wrapped one not twice', () => {
         // As a stdio connection replaces the methods, before `startLanguageServer` installs again.
         const secondPatch = vi.fn();
         const wrapped = console.error;
         console.error = secondPatch;
         try {
            installConsoleTee();
            const tee = console.error;
            installConsoleTee();
            expect(console.error).toBe(tee);
            console.error('after-second-connection');

            expect(linesMatching(/^\[Error - [\d:.]+\] \[console\] after-second-connection$/gm)).toBe(1);
            expect(secondPatch).toHaveBeenCalledTimes(1);
         } finally {
            console.error = wrapped;
         }
      });

      it('stamps a console line with the system clock, never reading the first logger Clock service', () => {
         // Reading it from a console call made while another service is built can resolve it into a cycle.
         const clock = Object.getOwnPropertyDescriptor(firstServices, 'Clock');
         const read = vi.fn(() => {
            throw new Error('Cycle detected');
         });
         Object.defineProperty(firstServices, 'Clock', { get: read, configurable: true });
         try {
            console.warn('system-clock');

            expect(linesMatching(/^\[Warn {2}- [\d:.]+\] \[console\] system-clock$/gm)).toBe(1);
            expect(read).not.toHaveBeenCalled();
         } finally {
            if (clock) {
               Object.defineProperty(firstServices, 'Clock', clock);
            }
         }
      });

      it("writes Node's process warning at warn, whatever the runtime's name, and another console.error line at error", () => {
         console.error('(node:4242) [DEP0999] DeprecationWarning: probe');
         console.error('(electron:4242) Warning: renamed runtime');
         console.error('(node: not a warning');
         console.error('(line:12) unexpected token');
         console.log('(node:4242) Warning: logged, not warned');

         const contents = readFileSync(path, 'utf-8');
         expect(contents).toMatch(/^\[Warn {2}- [\d:.]+\] \[console\] \(node:4242\) \[DEP0999\] DeprecationWarning: probe$/m);
         expect(contents).toMatch(/^\[Warn {2}- [\d:.]+\] \[console\] \(electron:4242\) Warning: renamed runtime$/m);
         expect(contents).toMatch(/^\[Error - [\d:.]+\] \[console\] \(node: not a warning$/m);
         expect(contents).toMatch(/^\[Error - [\d:.]+\] \[console\] \(line:12\) unexpected token$/m);
         expect(contents).toMatch(/^\[Log {3}- [\d:.]+\] \[console\] \(node:4242\) Warning: logged, not warned$/m);
      });

      it('writes a line once when another library wraps the console between two installs', () => {
         const ours = console.warn;
         // A tracing library's wrapper over ours, which forwards to it.
         console.warn = (...args: unknown[]): void => ours(...args);
         try {
            installConsoleTee();
            console.warn('stacked');

            expect(linesMatching(/\[console\] stacked$/gm)).toBe(1);
         } finally {
            console.warn = ours;
         }
      });

      it('only passes on a console call made while a line is written', () => {
         const replaced = vi.fn();
         const wrapped = console.warn;
         console.warn = replaced;
         // A sink that logs, so writing the line calls the console again.
         setLogFileSink({
            append: (file, line) => {
               console.warn('from-sink');
               appendFileSync(file, line);
            },
            ensureDir: () => undefined
         });
         try {
            installConsoleTee();
            console.warn('outer');

            expect(replaced.mock.calls).toEqual([['from-sink'], ['outer']]);
            expect(linesMatching(/\[console\] outer$/gm)).toBe(1);
            expect(linesMatching(/from-sink/gm)).toBe(0);
         } finally {
            installNodeLogFileSink();
            console.warn = wrapped;
         }
      });

      it.each([
         ['without a stderr', { value: undefined }],
         [
            'whose stderr throws when read',
            {
               get: () => {
                  throw new Error('no stderr here');
               }
            }
         ]
      ])('leaves the console alone where a bundler shims process.env %s', (_shape, descriptor: PropertyDescriptor) => {
         const unwrapped = vi.fn();
         const wrapped = console.warn;
         console.warn = unwrapped;
         const stderr = Object.getOwnPropertyDescriptor(process, 'stderr');
         Object.defineProperty(process, 'stderr', { ...descriptor, configurable: true });
         try {
            expect(() => installConsoleTee()).not.toThrow();
            expect(console.warn).toBe(unwrapped);
         } finally {
            if (stderr) {
               Object.defineProperty(process, 'stderr', stderr);
            }
            console.warn = wrapped;
         }
      });

      it('keeps a read-only console method, or one that throws when read, and wraps the rest', () => {
         const info = Object.getOwnPropertyDescriptor(console, 'info');
         const log = Object.getOwnPropertyDescriptor(console, 'log');
         const readOnly = vi.fn();
         Object.defineProperty(console, 'info', { value: readOnly, writable: false, configurable: true });
         Object.defineProperty(console, 'log', {
            get: () => {
               throw new Error('locked');
            },
            configurable: true
         });
         const wrapped = console.debug;
         console.debug = vi.fn();
         try {
            expect(() => installConsoleTee()).not.toThrow();
            expect(console.info).toBe(readOnly);
            console.debug('after-read-only');
            expect(linesMatching(/\[console\] after-read-only$/gm)).toBe(1);
         } finally {
            if (info) {
               Object.defineProperty(console, 'info', info);
            }
            if (log) {
               Object.defineProperty(console, 'log', log);
            }
            console.debug = wrapped;
         }
      });

      it('passes a console line on when writing it to the file fails', () => {
         setLogFileSink({
            append: () => {
               throw new Error('disk gone');
            },
            ensureDir: () => undefined
         });
         try {
            expect(() => console.error('tee-fails')).not.toThrow();
            expect(passedOn).toHaveBeenCalledWith('tee-fails');
         } finally {
            installNodeLogFileSink();
         }
      });

      it('writes a console line to the file even when the replaced method throws', () => {
         passedOn.mockImplementationOnce(() => {
            throw new Error('Connection is disposed');
         });

         expect(() => console.error('after-disposal')).toThrow('Connection is disposed');
         expect(readFileSync(path, 'utf-8')).toMatch(/^\[Error - [\d:.]+\] \[console\] after-disposal$/m);
      });

      it('hands a line to a replaced method whose own apply throws', () => {
         const replaced = vi.fn();
         Object.defineProperty(replaced, 'apply', {
            value: () => {
               throw new Error('shadowed apply');
            }
         });
         const wrapped = console.warn;
         console.warn = replaced;
         try {
            installConsoleTee();
            expect(() => console.warn('own-apply')).not.toThrow();
            expect(replaced).toHaveBeenCalledWith('own-apply');
         } finally {
            console.warn = wrapped;
         }
      });
   });
});
