/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { interfaces } from 'inversify';

/**
 * One captured `bind(...)` or `rebind(...)` call on a {@link BindRecorder}.
 *
 * `chain` holds the follow-up methods in invocation order, one string per call,
 * rendered as `name(arg, …)`. Arguments are stringified inline so assertions
 * can compare structure without re-resolving service identifiers.
 */
export interface BindRecorderEntry {
   readonly kind: 'bind' | 'rebind';
   readonly token: unknown;
   readonly chain: string[];
}

/**
 * A spy set of Inversify binding hooks that records every call and its chain.
 * Hand them to a module-factory under test — they satisfy Inversify's
 * `interfaces.Bind` / `interfaces.Rebind` / `interfaces.Unbind` /
 * `interfaces.IsBound` shapes at the call site but never resolve real services.
 *
 * Together they match GLSP's `BindingContext`, so a factory taking the whole
 * context is called as `factory(recorder, options)` — the recorder *is*
 * structurally a context.
 *
 * Use {@link captured} to assert which tokens were touched and with what
 * fluent chain. {@link find} is a small ergonomic helper for the common
 * lookup pattern.
 */
export interface BindRecorder {
   readonly bind: interfaces.Bind;
   readonly rebind: interfaces.Rebind;
   readonly unbind: interfaces.Unbind;
   readonly isBound: interfaces.IsBound;
   readonly captured: readonly BindRecorderEntry[];
   /** Convenience lookup — returns the first entry matching both `kind` and `token`, or `undefined`. */
   find(kind: 'bind' | 'rebind', token: unknown): BindRecorderEntry | undefined;
}

/** Options for {@link makeBindRecorder}. */
export interface BindRecorderOptions {
   /**
    * What `isBound` answers. Defaults to `true` for every token, matching
    * production: a head registers its own module *after* the GLSP default
    * modules, so the tokens a framework module rebinds are already bound. Pass a
    * list to model a container where only those tokens are bound — e.g. to
    * exercise a factory's bind-instead-of-rebind fallback.
    */
   readonly boundTokens?: readonly unknown[];
}

/** Methods on Inversify's binding builder that the recorder traps verbatim. */
const RECORDED_CHAIN_METHODS = [
   'toSelf',
   'to',
   'toService',
   'toConstantValue',
   'toDynamicValue',
   'toFactory',
   'toFunction',
   'toAutoFactory',
   'toProvider',
   'inSingletonScope',
   'inTransientScope',
   'inRequestScope',
   'whenTargetNamed',
   'whenTargetTagged',
   'whenInjectedInto',
   'onActivation',
   'onDeactivation'
] as const;

/**
 * Build a {@link BindRecorder} for testing Inversify module factories without a
 * real container: hand it to the factory, then assert over {@link BindRecorder.find}.
 *
 * The `bind` / `rebind` functions return a chained proxy that ignores its
 * arguments structurally but records every method invocation as a string.
 * Stringification: functions → `<className>`, symbols → `Symbol(desc).toString()`,
 * everything else → `String(value)`. This is enough to assert which tokens are
 * involved without dragging real service resolution into the test.
 */
export function makeBindRecorder(options: BindRecorderOptions = {}): BindRecorder {
   const captured: BindRecorderEntry[] = [];

   const stringifyArg = (value: unknown): string => {
      if (typeof value === 'function') {
         return `<${value.name || 'fn'}>`;
      }
      if (typeof value === 'symbol') {
         return value.toString();
      }
      return String(value);
   };

   const beginEntry = (kind: 'bind' | 'rebind', token: unknown): unknown => {
      const entry: BindRecorderEntry = { kind, token, chain: [] };
      captured.push(entry);
      const proxy: Record<string, (...args: unknown[]) => unknown> = {};
      for (const method of RECORDED_CHAIN_METHODS) {
         proxy[method] = (...args: unknown[]): unknown => {
            entry.chain.push(`${method}(${args.map(stringifyArg).join(', ')})`);
            return proxy;
         };
      }
      return proxy;
   };

   const bind = ((token: unknown) => beginEntry('bind', token)) as interfaces.Bind;
   const rebind = ((token: unknown) => beginEntry('rebind', token)) as interfaces.Rebind;
   const unbind = (() => undefined) as unknown as interfaces.Unbind;
   const isBound = ((token: unknown) => options.boundTokens?.includes(token) ?? true) as interfaces.IsBound;
   const find = (kind: 'bind' | 'rebind', token: unknown): BindRecorderEntry | undefined =>
      captured.find(entry => entry.kind === kind && entry.token === token);

   return { bind, rebind, unbind, isBound, captured, find };
}
