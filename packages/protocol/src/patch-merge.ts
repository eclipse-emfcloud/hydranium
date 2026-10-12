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
 * takes it as the new base, takes `theirs` as the new base on
 * `already-applied`, drops + surfaces the `theirs` root on `conflict`,
 * catches up with the server on `no-op`, and decides its own fallback (e.g.
 * force-retry) on `unavailable`.
 */
export type ReconcileOutcome<T> =
   | {
        /**
         * The replay succeeded: the foreign writer touched no path the user
         * did, or wrote the user's value at one that runs through no array.
         */
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
        /** The refetch already holds every path the user changed at the user's value: nothing is left to write. */
        status: 'already-applied';
        /**
         * The server's current root, refetched and unmodified. Take it as the
         * new base, not `ours`: it can also hold another writer's edit to a
         * path the user did not change.
         */
        theirs: T;
     }
   | {
        /**
         * User and foreign writer changed one path to different values, or
         * both changed one inside an array the refetch holds otherwise than
         * the user, even to the same value; both inserted the same array
         * element; or the foreign writer removed or replaced what the user
         * edited inside.
         */
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
 * - `already-applied` — the refetch already holds the user's value at every
 *   path the user changed, and the user's whole array for a path through
 *   one; nothing is replayed.
 * - `merged` — the foreign writer touched only paths the user did not, or
 *   made the user's change itself at a path through no array; the merged
 *   root carries both intents.
 * - `conflict` — a same-path divergence tripped a `test` op, including the
 *   user's own value inside an array the refetch holds otherwise than the
 *   user; or an `add` collides with one the foreign writer made; or the
 *   foreign writer removed or replaced what the user edited inside. The
 *   caller drops the write and surfaces `theirs`.
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
   const comparable = toJson(theirs);
   const pending = withoutAgreed(base, ours, comparable, userPatch);
   if (pending.length === 0) {
      return { status: 'already-applied', theirs };
   }
   if (addsCollide(base, comparable, pending)) {
      return { status: 'conflict', theirs };
   }
   try {
      const merged = applyPatch(deepClone(theirs), augmentWithTestOps(base, pending), true).newDocument;
      return { status: 'merged', merged };
   } catch {
      return { status: 'conflict', theirs };
   }
}

/**
 * `userPatch` without the ops `theirs` already agrees with: a `replace` or
 * object-key `add` whose key the object at its parent path holds at the
 * user's value, a `remove` whose key that object lacks. A parent that is
 * absent or no object agrees with nothing: a foreign writer deleted or
 * replaced what the user edited inside, or a refetch omitted a document it
 * could not read.
 *
 * Ops address array elements by index, so an op through an array agrees only
 * when that array, the outermost on its path, equals the user's: matching one
 * index of an array that shifted would drop the user's edit to another
 * element. An insert never agrees, as {@link addsCollide} keeps two equal
 * additions apart, and neither does any op through its array, or replaying
 * the insert alone would add its element a second time. Each array is
 * compared once, however many ops run through it and however many arrays the
 * patch inserts into, so a bulk edit stays linear.
 *
 * `theirs` is the refetch through {@link toJson}.
 */
function withoutAgreed(base: object, ours: object, theirs: object, userPatch: readonly JsonPatchOperation[]): JsonPatchOperation[] {
   const jsonOurs = toJson(ours);
   // An insert is keyed by the outermost array on its path, as every op is looked up, so one set answers for every array.
   const insertedArrays = new Set(
      userPatch
         .filter(op => op.op === 'add' && Array.isArray(valueAt(base, op.path.slice(0, op.path.lastIndexOf('/')))))
         .map(op => outermostArrayOn(jsonOurs, op.path))
   );
   const arrayAgrees = new Map<string, boolean>();
   return userPatch.filter(op => {
      const array = outermostArrayOn(jsonOurs, op.path);
      if (array !== undefined) {
         let agrees = arrayAgrees.get(array);
         if (agrees === undefined) {
            agrees = !insertedArrays.has(array) && _areEquals(valueAt(theirs, array), valueAt(jsonOurs, array));
            arrayAgrees.set(array, agrees);
         }
         return !agrees;
      }
      const cut = op.path.lastIndexOf('/');
      const parent = valueAt(theirs, op.path.slice(0, cut));
      if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) {
         return true;
      }
      const key = unescapePathComponent(op.path.slice(cut + 1));
      if (op.op === 'remove') {
         return Object.hasOwn(parent, key);
      }
      if (op.op !== 'replace' && op.op !== 'add') {
         return true;
      }
      return !Object.hasOwn(parent, key) || !_areEquals(Reflect.get(parent, key), op.value);
   });
}

/** The outermost array a step of `pointer` before its last runs through in `document`, as a pointer; `undefined` for none. */
function outermostArrayOn(document: object, pointer: string): string | undefined {
   const steps = pointer.split('/');
   for (let i = 1; i < steps.length; i++) {
      const prefix = steps.slice(0, i).join('/');
      if (Array.isArray(valueAt(document, prefix))) {
         return prefix;
      }
   }
   return undefined;
}

/**
 * `value` through JSON, as `compare` clones the values it diffs: an
 * undefined-valued key would otherwise make two equal values differ.
 */
function toJson<T>(value: T): T {
   return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Whether an `add` of `userPatch` collides with one the foreign writer made:
 * it inserts a value into an array that `theirs` holds more often than
 * `base` did, or it adds an object key that `theirs` already holds, at
 * another value once `withoutAgreed` has dropped the equal ones.
 *
 * Replayed, the first inserts the value a second time and the second replaces
 * the foreign value. Identical array elements conflict rather than being
 * skipped: skipping drops one of two insertions that merely happen to be
 * equal. `theirs` is the refetch through {@link toJson}.
 */
function addsCollide(base: object, theirs: object, userPatch: readonly JsonPatchOperation[]): boolean {
   // Each array's elements are counted once, however many ops insert into it, so a bulk insert stays linear.
   const tallies = new Map<string, { readonly before: ReadonlyMap<string, number>; readonly now: ReadonlyMap<string, number> }>();
   return userPatch.some(op => {
      if (op.op !== 'add') {
         return false;
      }
      const cut = op.path.lastIndexOf('/');
      const parent = op.path.slice(0, cut);
      const before = valueAt(base, parent);
      const now = valueAt(theirs, parent);
      if (Array.isArray(before)) {
         if (!Array.isArray(now)) {
            return false;
         }
         let tally = tallies.get(parent);
         if (!tally) {
            tally = { before: tallyElements(before), now: tallyElements(now) };
            tallies.set(parent, tally);
         }
         const key = canonicalJson(op.value);
         return (tally.now.get(key) ?? 0) > (tally.before.get(key) ?? 0);
      }
      return typeof now === 'object' && now !== null && Object.hasOwn(now, unescapePathComponent(op.path.slice(cut + 1)));
   });
}

/** How many elements of `array` there are of each value, keyed by {@link canonicalJson}. */
function tallyElements(array: readonly unknown[]): ReadonlyMap<string, number> {
   const tally = new Map<string, number>();
   for (const element of array) {
      const key = canonicalJson(element);
      tally.set(key, (tally.get(key) ?? 0) + 1);
   }
   return tally;
}

/** `value` as JSON with every object's keys sorted, so two deeply equal values give one string whatever their key order. */
function canonicalJson(value: unknown): string {
   return JSON.stringify(value, (_key, nested: unknown) =>
      typeof nested === 'object' && nested !== null && !Array.isArray(nested)
         ? Object.fromEntries(Object.entries(nested).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
         : nested
   );
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
    * acts on (persist `merged`, write nothing on `already-applied`, drop on
    * `conflict`, catch up on `no-op`, fall back on `unavailable`).
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
