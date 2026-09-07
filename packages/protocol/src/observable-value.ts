/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Disposable, type Event } from 'vscode-jsonrpc';

/**
 * A value that may change over the connection lifetime. `value` is the
 * current snapshot; `onChange` fires when the snapshot is replaced.
 *
 * The dynamic source in practice is always a user-configurable setting (see
 * the `Settings` producers, which bind one to a Langium configuration
 * section), but the type is source-agnostic — a constant wrapped via
 * {@link ObservableValue.of} is still an `ObservableValue`; its `onChange`
 * simply never fires. Recognised structurally by {@link isObservableValue}.
 */
export interface ObservableValue<T> {
   /**
    * `readonly` means the holder cannot assign it, NOT that it is stable —
    * a live cell backs this with a getter, so it must be read at the point of
    * use. Copying it into a field at construction pins the snapshot and
    * silently defeats the whole type. A setting-bound cell answers its declared
    * default until the client's configuration fetch resolves, so an early read
    * is a legitimate value rather than an error.
    */
   readonly value: T;
   /**
    * Fires when {@link value} is replaced, deduplicated by `Object.is`, so an
    * unchanged push is not re-announced. Subscribing is OPTIONAL and usually
    * unnecessary — reading `.value` per use already sees every change; the
    * event is for consumers that must re-arm something a later read cannot fix
    * (a timer already scheduled, a listener already registered).
    *
    * It never fires at all for a constant cell, so logic that lives only in an
    * `onChange` handler does nothing when an adopter passes a plain value.
    * Dispose what subscribing returns.
    */
   readonly onChange: Event<T>;
}

/**
 * What a service option accepts: either a plain constant (one-shot, never
 * changes) or an {@link ObservableValue}. Consumers normalise to a cell once
 * via {@link ObservableValue.from} and read `.value` at the point of use.
 */
export type MaybeObservableValue<T> = T | ObservableValue<T>;

const NOOP_DISPOSABLE: Disposable = Object.freeze({ dispose: () => undefined });

/** An {@link Event} that never fires — the `onChange` of a constant cell. */
const NEVER_EVENT: Event<never> = () => NOOP_DISPOSABLE;

/**
 * Type-guard discriminating a {@link MaybeObservableValue} into its {@link ObservableValue}
 * arm. Returns `false` for primitives, `null`, and any non-object payload; for
 * objects, requires both a `value` property and a callable `onChange` accessor
 * (vscode-jsonrpc events are exposed as callable subscribers).
 */
export function isObservableValue<T>(input: MaybeObservableValue<T>): input is ObservableValue<T> {
   if (input === null || typeof input !== 'object') {
      return false;
   }
   const candidate = input as Partial<ObservableValue<T>>;
   return 'value' in candidate && typeof candidate.onChange === 'function';
}

export namespace ObservableValue {
   /**
    * Wrap a constant as an {@link ObservableValue} whose `onChange` never
    * fires. Adopters rarely need this — the constant arm of {@link MaybeObservableValue}
    * already accepts a bare value; it exists for {@link from} and for tests
    * that want an explicit cell.
    */
   export function of<T>(value: T): ObservableValue<T> {
      return { value, onChange: NEVER_EVENT as Event<T> };
   }

   /**
    * Normalise a {@link MaybeObservableValue} to an {@link ObservableValue}. Identity for a
    * cell (preserving its live `value` getter + `onChange`); wraps a constant
    * via {@link of}. The combinator a consumer calls once in its constructor
    * so the rest of the class reads `.value` uniformly.
    */
   export function from<T>(input: MaybeObservableValue<T>): ObservableValue<T> {
      return isObservableValue(input) ? input : of(input);
   }
}
