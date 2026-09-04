/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { Emitter } from 'vscode-jsonrpc';
import { isObservableValue, ObservableValue, type MaybeObservableValue } from '../src/observable-value.js';
import { tick } from '../src/testing/wait-for.js';

/** Minimal writable `ObservableValue<T>` for tests — a `current` snapshot + emitter. */
function makeObservable<T>(initial: T): ObservableValue<T> & { set: (next: T) => void } {
   const emitter = new Emitter<T>();
   let current = initial;
   return {
      get value(): T {
         return current;
      },
      onChange: emitter.event,
      set(next: T): void {
         current = next;
         emitter.fire(next);
      }
   };
}

describe('ObservableValue.of', () => {
   it('wraps a constant in a cell whose value is the constant', () => {
      expect(ObservableValue.of(5).value).toBe(5);
   });

   it('never fires onChange (a constant cannot change)', async () => {
      let fired = false;
      ObservableValue.of(5).onChange(() => {
         fired = true;
      });
      // An absence is not provable synchronously: a microtask- or timer-borne
      // emission is still ahead of a read taken on the subscribe's own tick,
      // so that read is satisfied by any asynchronous delivery. Wait longer
      // than a delivery would take before concluding none happened.
      await tick(50);
      expect(fired).toBe(false);
   });

   it('returns a subscribable onChange that yields a disposable', () => {
      const disposable = ObservableValue.of(5).onChange(() => undefined);
      expect(typeof disposable.dispose).toBe('function');
   });
});

describe('ObservableValue.from', () => {
   it('wraps a bare constant into a cell', () => {
      const cell = ObservableValue.from(7 as MaybeObservableValue<number>);
      expect(cell.value).toBe(7);
   });

   it('returns the same instance for an ObservableValue input (identity passthrough)', () => {
      const live = makeObservable(1);
      expect(ObservableValue.from(live as MaybeObservableValue<number>)).toBe(live);
   });

   it('reflects the latest value when the underlying cell changes', () => {
      const live = makeObservable(1);
      const cell = ObservableValue.from(live as MaybeObservableValue<number>);
      live.set(2);
      expect(cell.value).toBe(2);
   });
});

describe('isObservableValue', () => {
   it('is true for an object with a value field and a callable onChange', () => {
      expect(isObservableValue(makeObservable(0))).toBe(true);
   });

   it('is false for a bare constant', () => {
      expect(isObservableValue(5 as MaybeObservableValue<number>)).toBe(false);
   });

   it('is false for null', () => {
      expect(isObservableValue(null as unknown as MaybeObservableValue<number>)).toBe(false);
   });
});
