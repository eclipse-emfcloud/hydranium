/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type ObservableValue } from '@hydranium/protocol';
import { Emitter } from 'vscode-languageserver';
import { type ServerSharedServices } from '../module.js';

/** True only when `T` is exactly `unknown` (distinguishing it from `any`). */
type IsUnknown<T> = unknown extends T ? ([T] extends [never] ? false : T extends never ? false : true) : false;

/**
 * Union of valid path tuples through `T` — manually unrolled to four levels
 * (TS conditional-type recursion saturates around depth 5 and trips
 * "instantiation excessively deep" through generic helpers). LSP config trees
 * are almost always <= 3 levels in practice.
 */
type Path<T> = T extends object
   ? {
        [K in keyof T & string]: NonNullable<T[K]> extends object
           ? readonly [K] | readonly [K, ...Extract<PathL2<NonNullable<T[K]>>, readonly string[]>]
           : readonly [K];
     }[keyof T & string]
   : never;

type PathL2<T> = T extends object
   ? {
        [K in keyof T & string]: NonNullable<T[K]> extends object
           ? readonly [K] | readonly [K, ...Extract<PathL3<NonNullable<T[K]>>, readonly string[]>]
           : readonly [K];
     }[keyof T & string]
   : never;

type PathL3<T> = T extends object
   ? {
        [K in keyof T & string]: NonNullable<T[K]> extends object
           ? readonly [K] | readonly [K, ...Extract<PathL4<NonNullable<T[K]>>, readonly string[]>]
           : readonly [K];
     }[keyof T & string]
   : never;

type PathL4<T> = T extends object
   ? {
        [K in keyof T & string]: readonly [K];
     }[keyof T & string]
   : never;

/**
 * Walk a (possibly nested) key path inside the `configuration` subtree
 * returned by `getConfiguration(root, configuration)`. Returns `undefined`
 * for any intermediate non-object or missing key — the caller's coercion +
 * validation then surfaces that as the default.
 */
function readKey(subtree: unknown, key: string | readonly string[]): unknown {
   const segments = typeof key === 'string' ? [key] : key;
   let current: unknown = subtree;
   for (const segment of segments) {
      if (current === null || typeof current !== 'object') {
         return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
   }
   return current;
}

/**
 * Producers that bind a user-configurable editor setting (an LSP
 * `workspace/configuration` section) to an {@link ObservableValue} — the
 * snapshot updates on the initial fetch and on every `didChangeConfiguration`
 * push for the section. `Settings` is reserved for this user-config source;
 * the {@link ObservableValue} the producers yield is itself source-agnostic.
 */
export namespace Settings {
   /** Accepted `key` shape for a given `TConfig` (top-level key or nested path tuple). */
   export type Key<TConfig> = IsUnknown<TConfig> extends true ? string | readonly string[] : (keyof TConfig & string) | Path<TConfig>;

   /**
    * Construction options for {@link Settings.value}. The two-key shape
    * (`root` + `configuration`) mirrors Langium's
    * `ConfigurationProvider.getConfiguration(language, configuration)`: `root`
    * selects the top-level section (typically the language id), `configuration`
    * is the first-level key beneath it, and `select` does the deep traversal.
    */
   export interface ValueOptions<TConfig, TValue> {
      readonly services: ServerSharedServices;
      /**
       * LSP configuration section root. Defaults to
       * `services.lsp.configurationRoot`; multi-grammar adopters rebind that
       * slot to dispatch by language id. Single-grammar adopters rarely pass it.
       */
      readonly root?: string;
      /** First-level key under `root` (NOT a dotted path — Langium semantics). */
      readonly configuration: string;
      /**
       * Default returned until the first fetch completes, and afterwards when
       * the configuration is absent or `select` returns `undefined` / `null`.
       */
      readonly default: TValue;
      /**
       * Deep-traverse the subtree returned by `getConfiguration(root,
       * configuration)`. Returns the typed `TValue`, or `undefined` / `null` /
       * throws to fall back to {@link ValueOptions.default}.
       */
      readonly select: (config: TConfig) => TValue | undefined | null;
   }

   /**
    * Bind a {@link ObservableValue} to a Langium configuration section. The
    * snapshot starts at `default` and updates when (a) the initial
    * `provider.getConfiguration` resolves and (b) every `didChangeConfiguration`
    * push affecting the same `root`. `onChange` is dedup'd by snapshot identity
    * (`Object.is`). Errors thrown by `select` fall back to `default`.
    */
   export function value<TConfig, TValue>(options: ValueOptions<TConfig, TValue>): ObservableValue<TValue> {
      const root = options.root ?? options.services.lsp.configurationRoot;
      const provider = options.services.workspace.ConfigurationProvider;
      const emitter = new Emitter<TValue>();
      let current = options.default;

      const apply = (subtree: unknown): void => {
         let candidate: TValue | undefined | null;
         try {
            candidate = options.select(subtree as TConfig);
         } catch {
            candidate = options.default;
         }
         const next: TValue = candidate === undefined || candidate === null ? options.default : candidate;
         if (!Object.is(next, current)) {
            current = next;
            emitter.fire(next);
         }
      };

      // Initial fetch — `provider.ready` resolves after the client's
      // `initialized` notification. Failures leave the snapshot at `default`;
      // it still updates via `onConfigurationSectionUpdate` if pushed later.
      void provider.ready
         .then(async () => {
            const subtree = await provider.getConfiguration(root, options.configuration);
            apply(subtree);
         })
         .catch(() => {
            // On the CHAIN, not inside the callback: a `ready` rejection is a
            // failure mode of its own, and a handler that only wraps
            // `getConfiguration` leaves it as an anonymous unhandled rejection.
         });

      provider.onConfigurationSectionUpdate(({ section, configuration }: { section: string; configuration: unknown }) => {
         if (section !== root) {
            return;
         }
         const subtree =
            configuration === null || typeof configuration !== 'object'
               ? undefined
               : (configuration as Record<string, unknown>)[options.configuration];
         apply(subtree);
      });

      return {
         get value(): TValue {
            return current;
         },
         onChange: emitter.event
      };
   }

   /**
    * Common options shared by the typed readers ({@link Settings.number},
    * {@link Settings.boolean}, {@link Settings.string}). Each binds a value at
    * `<root>.<configuration>.<key>`. `default` is returned whenever the
    * configuration is absent, the raw value is the wrong shape, or coercion /
    * validation rejects it.
    */
   export interface ReaderOptions<T, TConfig = unknown> {
      readonly services: ServerSharedServices;
      readonly root?: string;
      readonly configuration: string;
      /**
       * Key or path inside the `configuration` subtree. Narrows to the valid
       * paths through `TConfig` when a schema is declared; otherwise
       * `string | readonly string[]`.
       */
      readonly key: Key<TConfig>;
      readonly default: T;
   }

   /** Options for {@link Settings.number}. */
   export interface NumberOptions<TConfig = unknown> extends ReaderOptions<number, TConfig> {
      /** Coerce string-typed values via `Number.parseFloat`. Default: `true`. */
      readonly coerceString?: boolean;
      /** Reject negative values. Default: `false`. */
      readonly nonNegative?: boolean;
      /** Round to the nearest integer via `Math.round`. Default: `false`. */
      readonly integer?: boolean;
      /** Reject values below `min`. */
      readonly min?: number;
      /** Reject values above `max`. */
      readonly max?: number;
   }

   /** Options for {@link Settings.boolean}. */
   export interface BooleanOptions<TConfig = unknown> extends ReaderOptions<boolean, TConfig> {
      /** Coerce `'true'`/`'false'`/`'1'`/`'0'` (case-insensitive). Default: `true`. */
      readonly coerceString?: boolean;
   }

   /** Options for {@link Settings.string}. */
   export interface StringOptions<T extends string = string, TConfig = unknown> extends ReaderOptions<T, TConfig> {
      /** Restrict accepted values to a set. */
      readonly allowed?: readonly T[];
      /** Coerce non-string values via `String(value)`. Off by default. */
      readonly coerceToString?: boolean;
   }

   /**
    * Bind a numeric setting with optional string-coercion + range / integer
    * validation. Any rejection falls back to `default`.
    */
   export function number<TConfig = unknown>(options: NumberOptions<TConfig>): ObservableValue<number> {
      const coerceString = options.coerceString ?? true;
      return value<unknown, number>({
         services: options.services,
         root: options.root,
         configuration: options.configuration,
         default: options.default,
         select: subtree => {
            const raw = readKey(subtree, options.key);
            let result: number;
            if (typeof raw === 'number') {
               result = raw;
            } else if (typeof raw === 'string' && coerceString) {
               result = Number.parseFloat(raw);
            } else {
               return undefined;
            }
            if (!Number.isFinite(result)) {
               return undefined;
            }
            if (options.nonNegative && result < 0) {
               return undefined;
            }
            if (options.min !== undefined && result < options.min) {
               return undefined;
            }
            if (options.max !== undefined && result > options.max) {
               return undefined;
            }
            return options.integer ? Math.round(result) : result;
         }
      });
   }

   /**
    * Bind a boolean setting with optional string-coercion (`'true'`/`'false'`/
    * `'1'`/`'0'`, case-insensitive). Any other shape falls back to `default`.
    */
   export function boolean<TConfig = unknown>(options: BooleanOptions<TConfig>): ObservableValue<boolean> {
      const coerceString = options.coerceString ?? true;
      return value<unknown, boolean>({
         services: options.services,
         root: options.root,
         configuration: options.configuration,
         default: options.default,
         select: subtree => {
            const raw = readKey(subtree, options.key);
            if (typeof raw === 'boolean') {
               return raw;
            }
            if (typeof raw === 'string' && coerceString) {
               const normalised = raw.trim().toLowerCase();
               if (normalised === 'true' || normalised === '1') {
                  return true;
               }
               if (normalised === 'false' || normalised === '0') {
                  return false;
               }
            }
            return undefined;
         }
      });
   }

   /**
    * Bind a string setting with optional non-string coercion + allowed-list
    * validation. Type-parameterise `T` to a literal-string union to correlate
    * the snapshot type with the `allowed` set at compile time.
    */
   export function string<T extends string = string, TConfig = unknown>(options: StringOptions<T, TConfig>): ObservableValue<T> {
      const coerceToString = options.coerceToString ?? false;
      const allowed = options.allowed;
      return value<unknown, T>({
         services: options.services,
         root: options.root,
         configuration: options.configuration,
         default: options.default,
         select: subtree => {
            const raw = readKey(subtree, options.key);
            let result: string;
            if (typeof raw === 'string') {
               result = raw;
            } else if (coerceToString && raw !== undefined && raw !== null) {
               result = String(raw);
            } else {
               return undefined;
            }
            if (allowed && !allowed.includes(result as T)) {
               return undefined;
            }
            return result as T;
         }
      });
   }
}

/** Standard LSP message-tracing verbosity — the value of the `<langId>.trace.server` setting. */
export type TraceServerValue = 'off' | 'messages' | 'verbose';

/**
 * Shape of the standard `<langId>.trace` configuration section — `trace.server`
 * selects message-tracing verbosity. The framework owns this type because,
 * unlike bespoke per-adopter settings, it is universal across LSP adopters: a
 * server reads it through {@link Settings.string} without re-declaring the
 * shape, and gets an {@link ObservableValue} that tracks the user's edits.
 *
 * **A server usually has nothing to read here, which is why this type has no
 * in-repo consumer.** The setting is the CLIENT's: `vscode-languageclient`
 * reads `<clientId>.trace.server` itself, re-reads it on every configuration
 * change, writes the protocol trace to its own output channel, and forwards the
 * value to the server as the dedicated `$/setTrace` notification. So the value
 * already reaches a server on its own channel; going through
 * `workspace/configuration` is the indirect route to the same thing, and
 * nothing here registers a `$/setTrace` handler either.
 *
 * The one case that wants this type is a server choosing to mirror trace
 * verbosity onto its own `LogThreshold`. Weigh that deliberately rather than by
 * analogy: message tracing and application logging are orthogonal axes, so
 * mirroring means protocol tracing cannot be enabled without also raising
 * application log volume. The similar spelling is a false friend —
 * `trace.server: 'verbose'` and `LogThreshold`'s `'trace'` are unrelated.
 *
 * The client library does NOT contribute the schema. An adopter that wants the
 * setting to be discoverable declares it in its own host manifest
 * (`contributes.configuration`); in Theia that is not merely cosmetic, because
 * an unregistered preference is dropped as unknown rather than returned.
 */
export interface LspTraceConfiguration {
   server?: TraceServerValue;
}
