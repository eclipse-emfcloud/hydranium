/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type ILogger, LogLevel } from '@eclipse-glsp/client';
import { Logger } from '@hydranium/protocol';
import { inject, injectable } from 'inversify';
import { HydraniumClientTypes } from './types';

/** GLSP's wording for a request it resolved silently after its timeout. If
 *  upstream rewords it, the notice degrades to `debug` with the rest of `info`. */
const REQUEST_TIMED_OUT = /\btime out after \d+ms\b/;

/**
 * sprotty's `ILogger` over the host's {@link Logger}, so sprotty's own lines
 * reach the same sink as the framework's: a view-registration failure lands in
 * the Theia Output channel beside the action traffic, or on a page's console.
 * sprotty binds a `NullLogger` by default, which drops those failures.
 *
 * sprotty's `error` and `warn` keep their levels and their parameters, where
 * the parameter is the useful part, such as the element type that has no view.
 *
 * Its `info` is diagnosis, chatty on every hover's feedback, so it goes to
 * `debug`; the one anomaly reported there, a request GLSP resolved silently
 * after its timeout, goes to `warn`, where a default threshold shows it.
 *
 * Its `log` fires per action, per command and per render with the whole action
 * or model as a parameter, so it goes to `trace`, where the framework
 * dispatcher logs that traffic. **At `info` and `log` a parameter is reduced to
 * its name**, an action's `kind` or an object's class, never forwarded whole:
 * the Theia channel logger stringifies every parameter as JSON, so forwarding
 * them would write the model into the Output channel on every action.
 *
 * Each line goes through a logger nested under the host's for the calling
 * class, cached per class, so the origin is a tag the host renders inside its
 * own, `[GLSP client :: Viewer]`, not a prefix inside the message. Where
 * sprotty passes a sentence instead of the caller, as its layout registries
 * do, the sentence prefixes the message. The adapter's own `logLevel` is
 * sprotty's most verbose, so only the framework threshold filters; `info` and
 * `log` check it first, since they run on every action and render and would
 * otherwise format a line the threshold drops.
 *
 * Bound by `createGlspClientModule` via `rebind(TYPES.ILogger)`.
 */
@injectable()
export class SprottyLoggerAdapter implements ILogger {
   @inject(HydraniumClientTypes.Logger) protected readonly logger!: Logger;

   logLevel: LogLevel = LogLevel.log;

   /** Loggers derived per calling class; sprotty logs from a few dozen classes. */
   protected readonly loggers = new Map<string, Logger>();

   error(thisArg: unknown, message: string, ...params: unknown[]): void {
      this.loggerFor(thisArg).error(this.formatMessage(thisArg, message), ...params);
   }

   warn(thisArg: unknown, message: string, ...params: unknown[]): void {
      this.loggerFor(thisArg).warn(this.formatMessage(thisArg, message), ...params);
   }

   info(thisArg: unknown, message: string, ...params: unknown[]): void {
      if (REQUEST_TIMED_OUT.test(message)) {
         this.loggerFor(thisArg).warn(this.formatMessage(thisArg, message, params));
      } else if (Logger.isLevelEnabled('debug')) {
         this.loggerFor(thisArg).debug(this.formatMessage(thisArg, message, params));
      }
   }

   log(thisArg: unknown, message: string, ...params: unknown[]): void {
      if (Logger.isLevelEnabled('trace')) {
         this.loggerFor(thisArg).trace(this.formatMessage(thisArg, message, params));
      }
   }

   /** The host's logger with the calling class nested under its tag, or the
    *  host's own when the caller is not an object. */
   protected loggerFor(thisArg: unknown): Logger {
      const caller = typeof thisArg === 'object' && thisArg !== null ? this.nameOf(thisArg) : undefined;
      if (caller === undefined) {
         return this.logger;
      }
      let derived = this.loggers.get(caller);
      if (derived === undefined) {
         derived = this.logger.sub(caller);
         this.loggers.set(caller, derived);
      }
      return derived;
   }

   /** The message, behind the sentence sprotty sometimes passes as the caller,
    *  followed by the parameters' names. */
   protected formatMessage(thisArg: unknown, message: string, params: readonly unknown[] = []): string {
      const text = typeof thisArg === 'string' ? `${thisArg}${message}` : message;
      return [text, ...params.map(param => this.nameOf(param)).filter(name => name !== undefined)].join(' ');
   }

   /** An action's `kind`, also inside the message GLSP sends an action in, a
    *  string as it is, any other object's class, else nothing. */
   protected nameOf(value: unknown): string | undefined {
      if (typeof value === 'string') {
         return value;
      }
      if (typeof value !== 'object' || value === null) {
         return undefined;
      }
      const { kind, action } = value as { kind?: unknown; action?: { kind?: unknown } };
      if (typeof kind === 'string') {
         return kind;
      }
      if (typeof action?.kind === 'string') {
         return action.kind;
      }
      return value.constructor?.name;
   }
}
