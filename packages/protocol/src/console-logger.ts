/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractLogger } from './abstract-logger';
import { type LogLevel, type Logger } from './logger';

/** `console.trace` prints a stack with every line, so `trace` goes out at `debug`. */
const CONSOLE_METHODS: Record<LogLevel, 'error' | 'warn' | 'info' | 'debug'> = {
   error: 'error',
   warn: 'warn',
   info: 'info',
   debug: 'debug',
   trace: 'debug'
};

/**
 * {@link Logger} that writes each line to `console`, at the method matching its
 * level: the framework's `[Label - time] [component]` prefix and the message,
 * then any trailing arguments as they are, so a browser console can expand
 * them. For a browser page, webview or extension host, which has no other sink
 * to hand. On Node, `info` and `debug` reach stdout, so a process whose stdout
 * carries a protocol stream must not use it.
 */
export class ConsoleLogger extends AbstractLogger implements Logger {
   protected emit(level: LogLevel, label: string, message: string, args: readonly unknown[]): void {
      console[CONSOLE_METHODS[level]](`${this.formatLinePrefix(label)} ${message}`, ...args);
   }

   protected derive(component: string): this {
      const Subclass = this.constructor as new (component?: string) => this;
      return new Subclass(component);
   }
}
