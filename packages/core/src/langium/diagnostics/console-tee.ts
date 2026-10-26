/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Format, formatLogArg, LEVEL_LABELS, type LogLevel, SystemClock } from '@hydranium/protocol';
import { teeLogLine } from './logger.js';
import { hasProcessStderr } from '../../util/environment.js';
import { isConnectionGoneError } from '../../util/connection-liveness.js';

/** The `console` methods {@link installConsoleTee} wraps, with the level and label each line is written at. */
const CONSOLE_TEE: ReadonlyArray<readonly ['error' | 'warn' | 'info' | 'log' | 'debug', LogLevel, string]> = [
   ['error', 'error', LEVEL_LABELS.error],
   ['warn', 'warn', LEVEL_LABELS.warn],
   ['info', 'info', LEVEL_LABELS.info],
   ['log', 'info', 'Log'],
   ['debug', 'debug', LEVEL_LABELS.debug]
];

/** The wrappers this copy installed, so installing again wraps only a method that is none of them. */
const tees = new WeakSet<object>();
/**
 * Whether a line is being written or handed on: a console call made meanwhile,
 * by a sink or a library wrapper between two installs, is only handed on.
 */
let handling = false;
/**
 * What a line is stamped with: not a logger's injected clock, whose service a
 * console call made while another service is built could resolve into a cycle.
 */
const systemClock = new SystemClock();
/**
 * How a line's arguments are rendered, Node's `util.format` where the `./node`
 * entry set it: unlike JSON, it runs no ordinary getter and no proxy trap of an
 * argument it inspects, the traps a services container builds a service in.
 */
let format: ((...args: unknown[]) => string) | undefined;

/** Render console lines with `render`, as `installNodeLogFileSink` does with Node's `util.format`. */
export function setConsoleFormat(render: (...args: unknown[]) => string): void {
   format = render;
}

/**
 * Write each line sent through a {@link CONSOLE_TEE} method, as Langium
 * reports a linker or validator failure, to this copy's log file under a
 * `console` component, then hand it to the method it replaced, even when
 * writing the file fails. The file goes first because the method a stdio
 * connection installs throws once the connection is closed, unless its remote
 * console catches that, as `withHydraniumLspFeatures`'s does.
 *
 * Node only: in a browser no file is written, and a wrapper would only stand
 * between devtools and the call site. Called by the first `LspLogger`, and by
 * `startLanguageServer`, which wraps again where a logger existed before a
 * stdio connection replaced `error`, `warn`, `log` and `debug`. A console
 * replaced after that is not wrapped again, and each copy of this package
 * wraps the console itself, so a file two copies share gets a line twice.
 */
export function installConsoleTee(): void {
   if (!hasProcessStderr()) {
      return;
   }
   for (const [method, level, label] of CONSOLE_TEE) {
      try {
         wrap(method, level, label);
      } catch {
         // A host whose console is read-only, or throws when read, keeps its methods, unwritten.
      }
   }
}

/** Replace `console[method]` by a tee writing its lines at `level` under `label`, unless it is already one of this copy's tees. */
function wrap(method: (typeof CONSOLE_TEE)[number][0], level: LogLevel, label: string): void {
   const passOn = console[method];
   if (tees.has(passOn)) {
      return;
   }
   const tee = (...args: unknown[]): void => {
      if (handling) {
         Reflect.apply(passOn, console, args);
         return;
      }
      handling = true;
      try {
         try {
            const [lineLevel, lineLabel] = isDebugLine(args)
               ? (['debug', LEVEL_LABELS.debug] as const)
               : level === 'error' && isNodeWarning(args)
                 ? (['warn', LEVEL_LABELS.warn] as const)
                 : [level, label];
            // As `AbstractLogger.formatLinePrefix` starts a line.
            teeLogLine(
               lineLevel,
               () => `[${lineLabel.padEnd(5)} - ${Format.timestamp(new Date(systemClock.now()))}] [console] ${formatArgs(args)}`
            );
         } catch {
            // A failing log sink must not propagate, nor keep the line from `passOn`.
         }
         Reflect.apply(passOn, console, args);
      } finally {
         handling = false;
      }
   };
   console[method] = tee;
   tees.add(tee);
}

/** `args` as the console prints them, or by {@link formatLogArg} where that throws, as for an error whose stack throws when read. */
function formatArgs(args: unknown[]): string {
   if (format) {
      try {
         return format(...args);
      } catch {
         // Described below instead.
      }
   }
   return args.map(arg => formatLogArg(arg)).join(' ');
}

/**
 * How Node's default warning handler starts what it prints through
 * `console.error`: the runtime's release name and pid, the warning's code if
 * it has one, and its type, as `(node:42) [DEP0005] DeprecationWarning: `.
 */
const NODE_WARNING = /^\([\w-]+:\d+\) (\[\w+\] )?\w*Warning: /;

/** Whether `args` is a Node process warning, a deprecation say, which is written at `warn`. */
function isNodeWarning(args: readonly unknown[]): boolean {
   return args.length === 1 && typeof args[0] === 'string' && NODE_WARNING.test(args[0]);
}

/** What Langium's `initialized` handler logs when a service's start rejects. */
const LANGIUM_START_FAILURES = new Set<unknown>([
   'Error in ConfigurationProvider initialization:',
   'Error in WorkspaceManager initialization:'
]);

/**
 * Whether `args` reports routine teardown, which is written at `debug`:
 * Langium's failed configuration or workspace start whose connection has gone.
 * `vscode-languageserver`'s `Sending log message failed` is not, since it
 * carries no reason; `withHydraniumLspFeatures` keeps teardown from printing it.
 */
function isDebugLine(args: readonly unknown[]): boolean {
   return args.length === 2 && LANGIUM_START_FAILURES.has(args[0]) && isConnectionGoneError(args[1]);
}
