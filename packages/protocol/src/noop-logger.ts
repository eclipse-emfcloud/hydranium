/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractLogger } from './abstract-logger';
import { type LogLevel, type Logger } from './logger';

/**
 * {@link Logger} implementation that discards every message. Intended for
 * programmatic / in-process consumers (test harnesses, non-LSP hosts) that
 * use the framework services but don't have a vscode-jsonrpc connection to
 * forward log output through.
 *
 * Chaining methods (`for`, `sub`, `with`) return a noop instance of the same
 * class; `withUri` short-circuits to the same instance.
 */
export class NoopLogger extends AbstractLogger implements Logger {
   protected emit(_level: LogLevel, _label: string, _message: string, _args: readonly unknown[]): void {
      // noop — every message is discarded.
   }

   override withUri(_uri: string): this {
      // Composing a no-op label is wasted work — return the same instance.
      return this;
   }

   protected derive(component: string): this {
      const Subclass = this.constructor as new (component?: string) => this;
      return new Subclass(component);
   }
}
