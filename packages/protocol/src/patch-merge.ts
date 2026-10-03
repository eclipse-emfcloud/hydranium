/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   _areEquals,
   applyPatch,
   compare,
   deepClone,
   getValueByPointer,
   type Operation as JsonPatchOperation,
   unescapePathComponent
} from 'fast-json-patch';

/**
 * Augment a user-intent JSON patch (computed `base → ours`) with
 * `test` ops so a strict `applyPatch` against freshly-fetched server state
 * fails loudly when a foreign writer changed a path the user also changed.
 *
 * `fast-json-patch`'s `validateOperation: true` validates op structure and
 * path resolvability but NOT the pre-existing value — a plain `replace` /
 * `remove` silently overwrites whatever the foreign writer put there. For each
 * `replace` / `remove` op we prepend a `test` op carrying the base value at
 * that path, so a same-path divergence becomes a `TEST_OPERATION_FAILED` throw.
 * The caller treats that as a real field-level conflict (drop + refetch) rather
 * than silently clobbering the foreign edit.
 *
 * `add` ops get no `test` op: the path is new, so there is no base value
 * to test. {@link reconcileByPatchReplay} checks them against theirs
 * instead; a caller applying this patch itself does not get that check.
 *
 * Used behind the framework's `ConflictError` contract by every reconcile
 * path — the GLSP recording command's undo/redo and forward-write, via
 * {@link ReconcilingConflictResolver}, and an adopter's form-widget save — so
 * they share one collision-detection rule.
 */
export function augmentWithTestOps(base: object, userPatch: ReadonlyArray<JsonPatchOperation>): JsonPatchOperation[] {
   const augmented: JsonPatchOperation[] = [];
   for (const op of userPatch) {
      if (op.op === 'replace' || op.op === 'remove') {
         augmented.push({ op: 'test', path: op.path, value: getValueByPointer(base, op.path) });
      }
      augmented.push(op);
   }
   return augmented;
}

/**
 * Outcome of {@link reconcileByPatchReplay}. The caller persists `merged` and
 * takes it as the new base, drops + surfaces the `theirs` root on `conflict`,
 * catches up with the server on `no-op`, and decides its own fallback (e.g.
 * force-retry) on `unavailable`.
 */
export type ReconcileOutcome<T> =
   | {
        /** The replay succeeded: the foreign writer touched no path the user did. */
        status: 'merged';
        /**
         * A new root built on theirs, carrying both intents. It is NOT the
         * caller's `ours` root — take this value as the new base, or the next
         * write diffs against state the server never had.
         */
        merged: T;
     }
   | {
        /**
         * The user's root equalled the base, so the gate fired on another writer's
         * change and the caller is behind the server (`ConflictError.actualVersion`).
         * Nothing was refetched. Catch up from the update at that version or a later
         * one, or refetch; forcing the write overwrites the other writer's change.
         */
        status: 'no-op';
     }
   | {
        /** User and foreign writer changed one path, or both added the same element or key. */
        status: 'conflict';
        /**
         * The server's current root, refetched and unmodified — the user's
         * intent was NOT applied to it. Surface it and drop the write; treating
         * it as a merge result silently discards what the user typed.
         */
        theirs: T;
     }
   | {
        /**
         * The refetch produced nothing, so reconciliation could not be
         * attempted at all. This says nothing about whether a conflict exists;
         * the caller picks its own fallback (force-write, retry, surface).
         */
        status: 'unavailable';
     };

/**
 * Shared three-way reconcile for a `ConflictError`: diff the user's intent
 * (`base → ours`), refetch the server's current root (theirs), and replay the
 * intent on top under strict, {@link augmentWithTestOps}-guarded `applyPatch`.
 *
 * - `no-op` — the user's root equals the base: nothing to replay, and no
 *   refetch; the caller's document is behind the server's.
 * - `unavailable` — the refetch produced nothing; caller falls back.
 * - `merged` — the foreign writer touched only paths the user did not; the
 *   merged root carries both intents.
 * - `conflict` — a same-path divergence tripped a `test` op, or an `add`
 *   collides with one the foreign writer made; caller drops the write and
 *   surfaces `theirs`.
 *
 * I/O is the caller's: `refetch` supplies the current root, and applying the
 * `merged` result (update vs save, new base, UI refresh) stays at the call
 * site so form and GLSP paths keep their own persistence semantics.
 */
export async function reconcileByPatchReplay<T extends object>(
   base: T,
   ours: T,
   refetch: () => Promise<T | undefined>
): Promise<ReconcileOutcome<T>> {
   const userPatch = compare(base, ours);
   if (userPatch.length === 0) {
      return { status: 'no-op' };
   }
   const theirs = await refetch();
   if (!theirs) {
      return { status: 'unavailable' };
   }
   if (addsCollide(base, theirs, userPatch)) {
      return { status: 'conflict', theirs };
   }
   try {
      const merged = applyPatch(deepClone(theirs), augmentWithTestOps(base, userPatch), true).newDocument;
      return { status: 'merged', merged };
   } catch {
      return { status: 'conflict', theirs };
   }
}

/**
 * Whether an `add` of `userPatch` collides with one the foreign writer made:
 * it inserts a value into an array that `theirs` holds more often than
 * `base` did, or it adds an object key that `theirs` already holds.
 *
 * Replayed, the first inserts the value a second time and the second replaces
 * the foreign value. Identical values conflict rather than being skipped:
 * skipping drops one of two additions that merely happen to be equal.
 */
function addsCollide(base: object, theirs: object, userPatch: readonly JsonPatchOperation[]): boolean {
   // Through JSON, as `compare` clones the add values: an undefined-valued key
   // in `theirs` would otherwise make an equal element count as another.
   const comparable = JSON.parse(JSON.stringify(theirs)) as object;
   return userPatch.some(op => {
      if (op.op !== 'add') {
         return false;
      }
      const cut = op.path.lastIndexOf('/');
      const before = valueAt(base, op.path.slice(0, cut));
      const now = valueAt(comparable, op.path.slice(0, cut));
      if (Array.isArray(before)) {
         return Array.isArray(now) && occurrences(now, op.value) > occurrences(before, op.value);
      }
      return typeof now === 'object' && now !== null && Object.hasOwn(now, unescapePathComponent(op.path.slice(cut + 1)));
   });
}

/** How many elements of `array` deeply equal `value`, whatever their key order. */
function occurrences(array: readonly unknown[], value: unknown): number {
   return array.filter(element => _areEquals(element, value)).length;
}

/** The value at `pointer`, or `undefined` when a step of it is missing. */
function valueAt(document: object, pointer: string): unknown {
   try {
      return getValueByPointer(document, pointer);
   } catch {
      return undefined;
   }
}

/**
 * Strategy for resolving a write that raced a foreign edit. One declarative
 * choice covers every conflict site — `execute` forward-write `(before,
 * after)`, `undo` `(after, before)`, `redo` `(before, after)`, and form / GLSP
 * save `(lastSynced, newRoot)` — so adopters pick reconcile-vs-force once
 * (by binding a resolver) rather than per call site.
 */
export interface ConflictResolver {
   /**
    * Reconcile the user's `base → ours` intent against the current
    * server state (theirs, from `refetch`), returning a {@link ReconcileOutcome} the caller
    * acts on (persist `merged`, drop on `conflict`, catch up on `no-op`, fall
    * back on `unavailable`).
    */
   resolve<T extends object>(base: T, ours: T, refetch: () => Promise<T | undefined>): Promise<ReconcileOutcome<T>>;
}

/**
 * Default {@link ConflictResolver}: field-level three-way merge via
 * {@link reconcileByPatchReplay}. A foreign edit to a different field is
 * merged; a same-field collision is reported as a conflict rather than
 * clobbered.
 */
export class ReconcilingConflictResolver implements ConflictResolver {
   resolve<T extends object>(base: T, ours: T, refetch: () => Promise<T | undefined>): Promise<ReconcileOutcome<T>> {
      return reconcileByPatchReplay(base, ours, refetch);
   }
}

/**
 * Last-writer-wins {@link ConflictResolver}: always reports the `ours`
 * state as merged, without refetching or guarding. Suitable for single-client
 * tools or always-regenerated artifacts where a concurrent foreign edit may be
 * overwritten. A foreign edit to any field is clobbered.
 */
export class ForceConflictResolver implements ConflictResolver {
   async resolve<T extends object>(_base: T, ours: T, _refetch: () => Promise<T | undefined>): Promise<ReconcileOutcome<T>> {
      return { status: 'merged', merged: ours };
   }
}
