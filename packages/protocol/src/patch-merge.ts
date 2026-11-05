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
   escapePathComponent,
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
 * Nor does it get the check for an array element another client moved. A
 * `test` checks the value at an index, not which element holds it.
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
         * the user, even to the same value. Both inserted the same array
         * element into an array matched by index, or items of one key and
         * different content into one matched by key. Or a reorder collided,
         * as {@link ReplayOptions.itemKey} says. Or the foreign writer
         * removed or replaced what the user edited inside, or moved it as
         * {@link reconcileByPatchReplay} says.
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
 *   user. Or an `add` collides with one the foreign writer made. Or the
 *   foreign writer removed or replaced what the user edited inside, or moved
 *   it. A move counts only on evidence: the element now at the index stood
 *   elsewhere, or every copy of the edited one is still there. A fresh
 *   element in the edited one's place takes the edit. The caller drops the
 *   write and surfaces `theirs`.
 *
 * With {@link ReplayOptions.itemKey}, an array matched by key escapes the
 * move check: an op follows its item to wherever the refetch holds it. Its
 * order merges, or conflicts, as that option says.
 *
 * I/O is the caller's: `refetch` supplies the current root, and applying the
 * `merged` result (update vs save, new base, UI refresh) stays at the call
 * site so form and GLSP paths keep their own persistence semantics.
 */
export async function reconcileByPatchReplay<T extends object>(
   base: T,
   ours: T,
   refetch: () => Promise<T | undefined>,
   options: ReplayOptions = {}
): Promise<ReconcileOutcome<T>> {
   const userPatch = compare(base, ours);
   if (userPatch.length === 0) {
      return { status: 'no-op' };
   }
   const theirs = await refetch();
   if (!theirs) {
      return { status: 'unavailable' };
   }
   return options.itemKey ? replayByKey(base, ours, theirs, options.itemKey) : replay(base, ours, theirs, userPatch);
}

/** Options of {@link reconcileByPatchReplay} and {@link editRoot}. */
export interface ReplayOptions {
   /**
    * The key of an array item. It may be passed any item of any array, at any
    * depth, so primitives and `null` too. Return `undefined` for an item
    * without a key rather than throw: what it throws, the reconcile rejects
    * with and the change of {@link editRoot} throws.
    *
    * An array is matched by key when every item has one and no key repeats,
    * in each of the base, the user's root and the refetch that holds it. Any
    * other array is matched by index, and so is everything in it, as is a
    * value one root holds as an array and another as no array. A key needs to
    * be unique only within its array. One key names one item, so an item both
    * sides inserted under one key is inserted once, and conflicts only when
    * its content differs. By index, two equal inserts stay two items and
    * conflict. Changing an item's key reads as removing it and inserting
    * another, so it conflicts with the other side's edit of that item, which
    * merges by index.
    *
    * The items' order is merged as one value: the user's when only the user
    * reordered the items the roots share, else the refetch's. Both reordering
    * them differently is a conflict, and so is one side reordering them where
    * the other removed the array. An item one side inserted follows the item
    * it followed there.
    */
   readonly itemKey?: (item: unknown) => string | undefined;
}

/**
 * A change for a form that hands back a whole new root per edit: `before` is
 * the root the form edited, `after` the one it handed back. The change
 * replays that edit on whatever newer root it is given. Pass it to an edit
 * that runs again on every newer snapshot, so another client's update stays
 * visible and a form model older than the root writes no update back.
 *
 * The change is dropped whole, and the root returned as it is, wherever
 * {@link reconcileByPatchReplay} would report a conflict: the server wins,
 * and an edit of several fields never lands in part.
 */
export function editRoot<T extends object>(before: T, after: T, options: ReplayOptions = {}): (root: T) => T {
   if (_areEquals(before, after)) {
      return root => root;
   }
   // The patch is made per call: its op values end up in the result, which another call must not share.
   return root => {
      const outcome = options.itemKey
         ? replayByKey(before, after, root, options.itemKey)
         : replay(before, after, root, compare(before, after));
      return outcome.status === 'merged' ? outcome.merged : root;
   };
}

/** A {@link ReconcileOutcome} once the refetch is in hand. */
type ReplayOutcome<T> = Exclude<ReconcileOutcome<T>, { status: 'no-op' } | { status: 'unavailable' }>;

/** {@link reconcileByPatchReplay} on the refetch `theirs`, with every array matched by index. */
function replay<T extends object>(base: T, ours: T, theirs: T, userPatch: readonly JsonPatchOperation[]): ReplayOutcome<T> {
   const comparable = toJson(theirs);
   const pending = withoutAgreed(base, ours, comparable, userPatch);
   if (pending.length === 0) {
      return { status: 'already-applied', theirs };
   }
   if (addsCollide(base, comparable, pending) || editsMovedElement(base, comparable, pending)) {
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
 * Prefixed to an item key in its array's object form, so a key that names an
 * `Object.prototype` member stays an own key that a patch may address.
 */
const ITEM_KEY_PREFIX = '#';

/** The keys of one array matched by key, prefixed, in the base, the user's root and the refetch. `undefined` where that root holds no array. */
type KeyLists = readonly [base?: readonly string[], ours?: readonly string[], theirs?: readonly string[]];

/**
 * {@link replay} with each array matched by key rewritten into an object from
 * prefixed key to item, so an op addresses an item by key and follows it to
 * any index. Ops address an array by index, and `compare` diffs one index by
 * index, so an insert before a row would otherwise read as an edit of every row.
 */
function replayByKey<T extends object>(base: T, ours: T, theirs: T, itemKey: (item: unknown) => string | undefined): ReplayOutcome<T> {
   const keyed = new Map<string, KeyLists>();
   const comparable = toJson(theirs);
   // Structural casts: the rewrite keeps each root's type apart from its keyed arrays.
   const [keyedBase, keyedOurs, keyedTheirs] = withArraysByKey([base, ours, comparable], '', itemKey, keyed) as [T, T, T];
   const arrays = new Map<string, KeyedArray>();
   for (const [pointer, lists] of keyed) {
      const kept = keptOrder(lists);
      if (!kept) {
         return { status: 'conflict', theirs };
      }
      arrays.set(pointer, { lists, kept });
   }
   const outcome = replay(keyedBase, keyedOurs, keyedTheirs, compare(keyedBase, keyedOurs));
   if (outcome.status === 'conflict') {
      return { status: 'conflict', theirs };
   }
   if (outcome.status === 'merged') {
      return { status: 'merged', merged: withArraysRestored(outcome.merged, '', arrays) as T };
   }
   // Applied in content, the refetch may still lack the user's order.
   const reordered = withArraysRestored(keyedTheirs, '', arrays) as T;
   return _areEquals(reordered, comparable) ? { status: 'already-applied', theirs } : { status: 'merged', merged: reordered };
}

/**
 * `roots`, values at `pointer` in the base, the user's root and the refetch,
 * with each array matched by key rewritten into its object form, recorded in
 * `keyed`. Arrays matched by index are kept as they are with all they hold: a
 * patch shifts their items, so a keyed array inside could not be found again.
 */
function withArraysByKey(
   roots: readonly unknown[],
   pointer: string,
   itemKey: (item: unknown) => string | undefined,
   keyed: Map<string, KeyLists>
): unknown[] {
   const present = roots.filter(root => root !== undefined);
   let children: Array<Map<string, unknown> | undefined>;
   if (present.length > 0 && present.every(Array.isArray)) {
      children = roots.map(root => (Array.isArray(root) ? itemsByKey(root, itemKey) : undefined));
      if (roots.some((root, i) => root !== undefined && !children[i])) {
         return [...roots];
      }
      const [base, ours, theirs] = children.map(items => items && [...items.keys()]);
      keyed.set(pointer, [base, ours, theirs]);
   } else if (present.length > 0 && present.every(root => typeof root === 'object' && root !== null && !Array.isArray(root))) {
      children = roots.map(root => (typeof root === 'object' && root !== null ? new Map(Object.entries(root)) : undefined));
   } else {
      return [...roots];
   }
   const rewritten = new Map<string, unknown[]>();
   for (const name of new Set(children.flatMap(items => (items ? [...items.keys()] : [])))) {
      rewritten.set(
         name,
         withArraysByKey(
            children.map(items => items?.get(name)),
            `${pointer}/${escapePathComponent(name)}`,
            itemKey,
            keyed
         )
      );
   }
   // Each root keeps its own property order, so a merge keeps the refetch's.
   // fromEntries makes even a `__proto__` key an own key.
   return children.map((items, i) => items && Object.fromEntries([...items.keys()].map(name => [name, rewritten.get(name)?.[i]])));
}

/** The items of `array` by prefixed key, `undefined` when an item has no key or a key repeats. */
function itemsByKey(array: readonly unknown[], itemKey: (item: unknown) => string | undefined): Map<string, unknown> | undefined {
   const items = new Map<string, unknown>();
   for (const item of array) {
      const key = itemKey(item);
      if (key === undefined || items.has(ITEM_KEY_PREFIX + key)) {
         return undefined;
      }
      items.set(ITEM_KEY_PREFIX + key, item);
   }
   return items;
}

/**
 * The order an array matched by key keeps, as {@link ReplayOptions.itemKey}
 * says: the user's when only the user reordered the items the roots share,
 * else the refetch's. `undefined` when both reordered them differently, or
 * one reordered them and the other removed the array. No op or `test` sees a
 * reorder, as the object form compares unordered.
 */
function keptOrder([base, ours, theirs]: KeyLists): readonly string[] | undefined {
   if (!base || (!ours && !theirs)) {
      return theirs ?? ours ?? [];
   }
   const held = [ours, theirs].filter(list => list !== undefined).map(list => new Set(list));
   const shared = new Set(base.filter(key => held.every(keys => keys.has(key))));
   const [was, user, foreign] = [base, ours, theirs].map(list => list && JSON.stringify(list.filter(key => shared.has(key))));
   if (!ours || !theirs) {
      return (user ?? foreign) === was ? (theirs ?? ours) : undefined;
   }
   if (user === was || user === foreign) {
      return theirs;
   }
   return foreign === was ? ours : undefined;
}

/** An array matched by key: its keys in each root, and the order it keeps. */
interface KeyedArray {
   readonly lists: KeyLists;
   readonly kept: readonly string[];
}

/** `value` with each object {@link withArraysByKey} made of an array, by `arrays`, an array again. */
function withArraysRestored(value: unknown, pointer: string, arrays: ReadonlyMap<string, KeyedArray>): unknown {
   if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return value;
   }
   const entries = Object.entries(value).map(([name, child]): [string, unknown] => [
      name,
      withArraysRestored(child, `${pointer}/${escapePathComponent(name)}`, arrays)
   ]);
   const array = arrays.get(pointer);
   return array ? arranged(new Map(entries), array) : Object.fromEntries(entries);
}

/**
 * The merged `items` of one array matched by key, in {@link keptOrder}. An item
 * that order lacks follows the item it followed in the root that holds it.
 * Linear, however many items either side inserted.
 */
function arranged(items: ReadonlyMap<string, unknown>, { lists, kept }: KeyedArray): unknown[] {
   const inKept = new Set(kept);
   // The items each kept item is followed by, from the start for `undefined`.
   const following = new Map<string | undefined, string[]>();
   for (const list of [lists[1], lists[2]]) {
      let anchor: string | undefined;
      for (const key of list ?? []) {
         if (inKept.has(key)) {
            anchor = key;
         } else {
            const inserted = following.get(anchor) ?? [];
            inserted.push(key);
            following.set(anchor, inserted);
         }
      }
   }
   const order = new Set<string>(following.get(undefined));
   for (const key of kept) {
      order.add(key);
      for (const next of following.get(key) ?? []) {
         order.add(next);
      }
   }
   // Each merged item comes from the refetch or a user op, so one of the lists holds it.
   return [...order].filter(key => items.has(key)).map(key => items.get(key));
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
 * equal. An item of an array matched by key is an object key here, so two
 * equal inserts under one key agree before this check, as
 * {@link ReplayOptions.itemKey} says. `theirs` is the refetch through
 * {@link toJson}.
 */
function addsCollide(base: object, theirs: object, userPatch: readonly JsonPatchOperation[]): boolean {
   // Each array's elements are counted once, however many ops insert into it, so a bulk insert stays linear.
   const tallies = new Map<string, ArrayTally>();
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

/**
 * Whether an op of `userPatch` edits inside an array element another client
 * moved. Theirs holds another element at its index, and either that element
 * stood elsewhere in `base`, with theirs holding no more copies of it, or
 * theirs still holds every copy of the edited one. Theirs holding no array
 * there counts too. Its `test` ops check a value, not which element holds it,
 * so the replay would edit the element that slid into the index.
 *
 * A changed element without that evidence is taken as edited in place, so an
 * edit beside another client's edit of the same element, or of an equal one,
 * still merges. Not caught: a move where the other client also edited both
 * the slid-in and the edited element, a fresh element in the edited one's
 * place, and a move between equal elements. An element another client edited
 * into a copy of another one, which it also edited or removed, reads as moved,
 * so the edit conflicts.
 *
 * `compare` addresses elements by their `base` index, as it appends inserts
 * and removes from the end. Each array is counted once, however many ops run
 * through it. `theirs` is the refetch through {@link toJson}.
 */
function editsMovedElement(base: object, theirs: object, userPatch: readonly JsonPatchOperation[]): boolean {
   const tallies = new Map<string, ArrayTally>();
   const moved = new Map<string, boolean>();
   return userPatch.some(op => {
      const steps = op.path.split('/');
      // The last step names the op's target: an insert, or an element its own `test` checks whole.
      for (let i = 1; i < steps.length - 1; i++) {
         const element = steps.slice(0, i + 1).join('/');
         let found = moved.get(element);
         if (found === undefined) {
            found = elementMoved(base, theirs, steps.slice(0, i).join('/'), Number(steps[i]), tallies);
            moved.set(element, found);
         }
         if (found) {
            return true;
         }
      }
      return false;
   });
}

/** Whether the element at `index` of the `base` array at `pointer` moved in `theirs`, or `theirs` holds no array there, as {@link editsMovedElement} decides it. */
function elementMoved(base: object, theirs: object, pointer: string, index: number, tallies: Map<string, ArrayTally>): boolean {
   const before = valueAt(base, pointer);
   if (!Array.isArray(before)) {
      return false;
   }
   const now = valueAt(theirs, pointer);
   if (!Array.isArray(now)) {
      return true;
   }
   const was = canonicalJson(before[index]);
   const is = canonicalJson(now[index]);
   if (was === is) {
      return false;
   }
   let tally = tallies.get(pointer);
   if (!tally) {
      tally = { before: tallyElements(before), now: tallyElements(now) };
      tallies.set(pointer, tally);
   }
   const movedIn = (tally.before.get(is) ?? 0) >= Math.max(tally.now.get(is) ?? 0, 1);
   const movedOut = (tally.now.get(was) ?? 0) >= (tally.before.get(was) ?? 0);
   return movedIn || movedOut;
}

/** The elements of one array in `base` and in theirs, each through {@link tallyElements}. */
interface ArrayTally {
   readonly before: ReadonlyMap<string, number>;
   readonly now: ReadonlyMap<string, number>;
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
 * clobbered. Made with an {@link ReplayOptions.itemKey}, it matches array
 * items by key.
 */
export class ReconcilingConflictResolver implements ConflictResolver {
   constructor(protected readonly options: ReplayOptions = {}) {}

   resolve<T extends object>(base: T, ours: T, refetch: () => Promise<T | undefined>): Promise<ReconcileOutcome<T>> {
      return reconcileByPatchReplay(base, ours, refetch, this.options);
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
