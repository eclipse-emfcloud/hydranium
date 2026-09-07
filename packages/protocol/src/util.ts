/********************************************************************************
 * Copyright (c) 2023 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** A user-defined type predicate. */
export type TypeGuard<T> = (item: unknown) => item is T;

/**
 * Minimal disposable shape, intentionally identical to `vscode-jsonrpc.Disposable`
 * by structural typing so it interoperates without an actual dependency on that
 * library. Consumers may pass instances of this type wherever a `Disposable`
 * is expected, and vice versa.
 *
 * Re-defined locally rather than re-exported from `vscode-jsonrpc` so adopters
 * pulling this interface in do not transitively see `vscode-jsonrpc` types as
 * part of the framework's public surface.
 */
export interface Disposable {
   dispose(): void;
}

export namespace Disposable {
   export function create(dispose: () => void): Disposable {
      return { dispose };
   }
   /**
    * Shared no-op {@link Disposable} — `dispose()` does nothing. Use wherever a
    * disposable is required but there is nothing to release (a subscription with
    * no teardown, a listener registration in a test double) instead of a fresh
    * `{ dispose: () => undefined }` literal. Frozen so the shared instance can't
    * be mutated.
    */
   export const EMPTY: Disposable = Object.freeze({ dispose: () => undefined });
}

/**
 * A collection of disposables that itself implements {@link Disposable}.
 *
 * - {@link dispose} is idempotent: repeat calls are safe.
 * - {@link push} returns the added disposable for chaining.
 * - Push-after-disposal disposes the added item immediately (prevents leaks
 *   from late arrivals on a collection that has already been torn down).
 * - LIFO drain order: last-pushed disposes first. Matches the convention that
 *   later disposables typically depend on earlier ones (e.g., a subscription
 *   depends on a connection, so the subscription must dispose first before
 *   the connection tears down its transport).
 * - A throwing dispose does not strand subsequent disposables in the drain.
 *
 * Fills the gap left by vscode-jsonrpc and Langium, which provide only the
 * `Disposable` interface and a `Disposable.create()` factory.
 */
export class DisposableCollection implements Disposable {
   protected readonly disposables: Disposable[] = [];
   protected _disposed = false;

   get disposed(): boolean {
      return this._disposed;
   }

   push(disposable: Disposable): Disposable {
      if (this._disposed) {
         disposable.dispose();
      } else {
         this.disposables.push(disposable);
      }
      return disposable;
   }

   dispose(): void {
      if (this._disposed) {
         return;
      }
      this._disposed = true;
      while (this.disposables.length > 0) {
         try {
            this.disposables.pop()!.dispose();
         } catch (_err) {
            // Continue draining — one failed dispose shouldn't strand the rest.
         }
      }
   }
}

/**
 * A `Promise` paired with its `resolve` / `reject` callbacks, so producer
 * and consumer code can be in different scopes. Use when a constructor
 * needs to expose a `ready` promise that a later method resolves.
 *
 * Equivalent to Theia / GLSP / Langium's `Deferred` utility — re-implemented
 * here so `@hydranium/protocol` stays runtime-dependency-free.
 */
export class Deferred<T = void> {
   readonly promise: Promise<T>;
   resolve!: (value: T | PromiseLike<T>) => void;
   reject!: (reason?: unknown) => void;

   constructor() {
      this.promise = new Promise<T>((resolve, reject) => {
         this.resolve = resolve;
         this.reject = reject;
      });
   }
}

/**
 * A value that is either `T` directly (sync) or a thenable that resolves to `T`
 * (async). Used in framework hook signatures where adopter overrides may be
 * either sync or async without forcing the synchronous fast path to pay an
 * unconditional microtask tick.
 *
 * Uses the permissive `PromiseLike<T>` form so externally-produced thenables
 * (non-native Promise implementations) also flow through.
 *
 * Pair with {@link isPromiseLike} at hot-loop call sites to preserve
 * the sync fast path (an `await` on a non-promise still schedules a microtask).
 */
export type MaybePromise<T> = T | PromiseLike<T>;

/**
 * Type guard distinguishing the async branch of {@link MaybePromise}.
 *
 * At framework call sites in tight loops, guarding before the `await` keeps
 * sync implementations on the synchronous fast path — `await` on
 * a non-promise still schedules a microtask, which for per-node loops adds
 * up. Outside of tight loops a naive `await maybe` is equivalent and
 * shorter; reach for the guard only when the call sits on the build's
 * critical path.
 *
 * Thenable check (`'then' in value`) rather than `instanceof Promise` so
 * non-native Promise implementations also classify as async.
 */
export function isPromiseLike<T = unknown>(value: MaybePromise<T>): value is PromiseLike<T> {
   return !!value && typeof (value as PromiseLike<T>).then === 'function';
}

/** Removes `readonly` from all properties of `T`. */
export type Mutable<T> = { -readonly [P in keyof T]: T[P] };

/** Returns the same value typed as a {@link Mutable}. Compile-time only. */
export function asMutable<T>(item: T): Mutable<T> {
   return item;
}

/** Type-guard variant: narrows `item` to `Mutable<T> | undefined` if `guard` accepts it. */
export function toMutable<T>(item: unknown, guard: TypeGuard<T>): item is Mutable<T> | undefined;
export function toMutable<T>(item: unknown, guard?: TypeGuard<T>): item is Mutable<T> | undefined {
   return guard ? guard(item) : true;
}

/**
 * Wrap `text` in `quoteChar`, escaping interior occurrences with `replaceChar`.
 *
 * - Empty input becomes a pair of quote characters.
 * - Pre-existing surrounding quotes are not double-wrapped.
 * - Interior `quoteChar` runs are mapped to `replaceChar`.
 */
export function quote(text: string, quoteChar = '"', replaceChar = "'"): string {
   if (text.length === 0) {
      return quoteChar + quoteChar;
   }
   let quoted = text;
   if (!quoted.startsWith(quoteChar)) {
      quoted = quoteChar + quoted;
   }
   if (!quoted.endsWith(quoteChar)) {
      quoted += quoteChar;
   }
   return (
      quoteChar +
      quoted
         .substring(1, quoted.length - 1)
         .split(quoteChar)
         .join(replaceChar) +
      quoteChar
   );
}

/** Strip a single layer of `quoteChar` from the start and end of `text` if present. */
export function unquote(text: string, quoteChar = '"'): string {
   const start = text.startsWith(quoteChar) ? 1 : undefined;
   const end = text.endsWith(quoteChar) ? -1 : undefined;
   return text.slice(start, end);
}

/** Capitalise the first character of `input`. */
export function toPascal(input: string): string {
   return input.charAt(0).toLocaleUpperCase() + input.slice(1);
}

/**
 * Format a [codicon](https://github.com/microsoft/vscode-codicons) name as the
 * CSS class string consumed by VS Code- and Theia-style icon hosts.
 *
 * Presentation, not wire contract, and a duplicate of `@eclipse-glsp/client`'s
 * export of the same name — a file importing both barrels gets an ambiguity, so
 * client code that already depends on GLSP takes the upstream one. It stays on
 * this barrel because adopter protocol packages re-export these helpers
 * wholesale, which makes relocating it a breaking change rather than a move.
 */
export function codiconCSSString(icon: string): string {
   return `codicon codicon-${icon}`;
}

/** The identity function. Useful as a default mapping callback. */
export function identity<T>(value: T): T {
   return value;
}

/** Find a name based on `suggestion` that is not already in `existing`, appending an
 *  incrementing numeric suffix until a free slot is found. */
export function findNextUnique(suggestion: string, existing: string[]): string;
export function findNextUnique<T>(suggestion: string, existing: T[], nameGetter: (element: T) => string): string;
export function findNextUnique<T>(suggestion: string, existing: T[], nameGetter?: (element: T) => string): string {
   const names = nameGetter ? existing.map(nameGetter) : (existing as string[]);
   let name = suggestion;
   let index = 1;
   while (names.includes(name)) {
      name = suggestion + index++;
   }
   return name;
}

/** Throw if reached. Helper for exhaustiveness checks at the end of a discriminated-union switch. */
export function unreachable(input: never): never {
   throw new Error('Value detected in unreachable assertion: ' + `${input}`);
}

/**
 * Resolve a nested value from a plain object using a path of property names.
 * Returns `undefined` for any segment that is not an object or is null.
 *
 * The generic `T` is a caller-provided assertion about the value's type — it
 * is not validated at runtime. Use `unknown` (the default) if the type is
 * uncertain, then narrow with a type-guard.
 */
export function getAt<T = unknown>(obj: unknown, path: string[]): T | undefined {
   let cur: unknown = obj;
   for (const seg of path) {
      if (cur == null || typeof cur !== 'object') {
         return undefined;
      }
      cur = (cur as Record<string, unknown>)[seg];
   }
   return cur as T;
}
