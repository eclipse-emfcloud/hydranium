/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractLogger, DefaultTracer, type LogLevel, type MemoryReader, SystemClock } from '@hydranium/protocol';
import { injectable, type interfaces, unmanaged, inject } from '@theia/core/shared/inversify';
import { type OutputChannel, OutputChannelManager } from '@theia/output/lib/browser/output-channel';

/**
 * Configuration for a {@link ChannelLogger}, supplied once at bind time via
 * {@link bindChannelLogger} (the framework's `(deps, options)` constructor
 * shape — the only piece an adopter must provide is the channel name).
 *
 * Note there is no log-threshold option here: the threshold is not a per-logger
 * concern. See {@link ChannelLogger} for why, and
 * `LogLevelPreferenceContribution` for the owner.
 */
export interface ChannelLoggerOptions {
   /** Name of the Theia Output channel lines are written to. */
   readonly channelName: string;
   /** Initial logger component prefix (see `Logger.for`). */
   readonly component?: string;
}

/** Inversify token for the {@link ChannelLoggerOptions} constant (merged with the
 *  interface name — the standard Theia "type + token under one identifier" idiom). */
export const ChannelLoggerOptions = Symbol('ChannelLoggerOptions');

/**
 * Writes client-side lines to a Theia Output channel, formatted to align with
 * the server-side `LspLogger` so both sides of the conversation interleave
 * cleanly under the same Output panel entry. Cross-head: the data, LSP, and
 * GLSP Theia integrations can all reuse it — nothing here is GLSP-specific.
 *
 * Concrete and options-configured: adopters wire it with
 * {@link bindChannelLogger}, supplying {@link ChannelLoggerOptions}, rather
 * than subclassing to pin a channel name.
 *
 * It deliberately owns **no** threshold logic. The threshold is a process-global
 * shared by every `AbstractLogger`, whereas this class's singleton scope is
 * whichever container bound it (for a GLSP head, one per diagram) — so applying a
 * global from here would subscribe a preference listener per container and never
 * dispose one. `LogLevelPreferenceContribution` owns it instead, at application
 * scope. This class only formats and appends.
 */
@injectable()
export class ChannelLogger extends AbstractLogger {
   protected _channel?: OutputChannel;

   constructor(
      @inject(OutputChannelManager) protected readonly outputChannels: OutputChannelManager,
      @inject(ChannelLoggerOptions) protected readonly options: ChannelLoggerOptions,
      @unmanaged() component: string | undefined = options.component
   ) {
      super(component);
   }

   protected get channel(): OutputChannel {
      return (this._channel ??= this.outputChannels.getChannel(this.options.channelName));
   }

   protected emit(_level: LogLevel, label: string, message: string, args: readonly unknown[]): void {
      const componentSegment = this.component ? ` [${this.component}]` : '';
      const formattedArgs = args.length > 0 ? ' ' + args.map(stringifyArg).join(' ') : '';
      // Pad to match the server's 5-char label width so timestamps align across sources.
      this.channel.appendLine(`[${label.padEnd(5)} - ${this.timestamp()}]${componentSegment} ${message}${formattedArgs}`);
   }

   /**
    * Allocates a free instance bypassing Inversify, so a derived logger inherits
    * the same OutputChannelManager + options without going through the container
    * singleton. Subclasses with additional constructor dependencies must
    * override and pass the extra args along.
    */
   protected derive(component: string): this {
      const Ctor = this.constructor as new (
         outputChannels: OutputChannelManager,
         options: ChannelLoggerOptions,
         component?: string
      ) => this;
      return new Ctor(this.outputChannels, this.options, component);
   }
}

/** Private token for the un-tagged singleton base that the per-class dynamic
 *  binding derives from. Kept module-internal so the only public token is the
 *  {@link ChannelLogger} class itself. */
const ChannelLoggerBase = Symbol('ChannelLoggerBase');

/**
 * Inversify token for the browser `Tracer` — a {@link DefaultTracer} over
 * the {@link ChannelLogger} (emit sink) + a {@link SystemClock} + a browser
 * heap reader. The browser head has no Langium `services.Tracer` slot, so this
 * is how frontend services that time obtain a tracer: `@inject(ChannelTracer)`.
 * Bound by {@link bindChannelLogger}.
 */
export const ChannelTracer = Symbol('ChannelTracer');

/** Reads the requesting class's name from an Inversify context, by walking the
 *  current request up to its parent binding. */
export function getRequestParentName(context: interfaces.Context): string | undefined {
   const parent = context.currentRequest.parentRequest;
   if (!parent || parent.bindings.length === 0) {
      return undefined;
   }
   const binding = parent.bindings[0] as interfaces.Binding<{ name?: string }>;
   return binding.implementationType?.name;
}

/**
 * Bind the {@link ChannelLogger} for an adopter's Theia frontend:
 *
 *   - `bind(ChannelLoggerOptions).toConstantValue(options)` — the config
 *   - the un-tagged singleton base (private token), constructed by Inversify
 *   - `bind(ChannelLogger).toDynamicValue(...)` — class-scoped per request, so
 *     every `@inject(ChannelLogger)` site gets a logger pre-tagged with the
 *     requesting class name
 *
 * Adopters that compose their own module (bypassing a head's module helper)
 * call this directly; head module helpers (`createGlspClientTheiaModule`)
 * forward to it.
 */
export function bindChannelLogger(bind: interfaces.Bind, options: ChannelLoggerOptions): void {
   bind(ChannelLoggerOptions).toConstantValue(options);
   bind(ChannelLoggerBase).to(ChannelLogger).inSingletonScope();
   bind(ChannelLogger).toDynamicValue(ctx => {
      const base = ctx.container.get<ChannelLogger>(ChannelLoggerBase);
      const parentName = getRequestParentName(ctx);
      return parentName ? base.for(parentName) : base;
   });
   bind(ChannelTracer)
      .toDynamicValue(ctx => new DefaultTracer(ctx.container.get<ChannelLogger>(ChannelLoggerBase), new SystemClock(), readBrowserMemory))
      .inSingletonScope();
}

interface ChromiumPerformance {
   memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
}

/** Browser heap reader for {@link ChannelTracer}, backed by Chromium's non-standard `performance.memory`. */
const readBrowserMemory: MemoryReader = () => {
   const mem = (performance as unknown as ChromiumPerformance).memory;
   return mem ? { usedBytes: mem.usedJSHeapSize, totalBytes: mem.totalJSHeapSize } : undefined;
};

function stringifyArg(arg: unknown): string {
   if (typeof arg === 'string') {
      return arg;
   }
   try {
      return JSON.stringify(arg);
   } catch {
      return String(arg);
   }
}
