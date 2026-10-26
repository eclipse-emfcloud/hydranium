/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describeErrorWithStack } from './messages/primitives';

/** How deep an object argument is rendered; a deeper object reads `[Object]` or `[Array]`. */
const LOG_ARG_DEPTH = 2;
/** How many items or keys of one array or object are rendered. */
const LOG_ARG_ITEMS = 100;
/** How many characters of one string or key inside an object argument are rendered. */
const LOG_ARG_STRING_LENGTH = 10_000;
/**
 * About how many characters one argument renders, since the limits above
 * multiply. The entry that would pass it reads `...`; later ones are left out.
 */
const LOG_ARG_LENGTH = 100_000;

/** Options of {@link formatLogArg}. An object, so that a `map` index cannot be passed as one. */
export interface FormatLogArgOptions {
   /** The `space` argument of `JSON.stringify`; compact where omitted. */
   readonly indent?: number;
}

/**
 * Render a log argument as text for a log line:
 * - a string as it is;
 * - an error by its stack and causes;
 * - another object as JSON, cut to a bounded size;
 * - anything else by its description, as is an object JSON renders as nothing
 *   or cannot render.
 *
 * The cut is needed because the log call serialises synchronously and every
 * Langium AST node is cyclic. The JSON stops at `LOG_ARG_DEPTH` levels,
 * `LOG_ARG_ITEMS` items or keys and `LOG_ARG_STRING_LENGTH` characters per
 * string or key, and at about `LOG_ARG_LENGTH` in all. A reference back to an
 * object that contains it reads `[Circular]`, and a BigInt its digits; the
 * markers are JSON strings. `util.inspect` would cut too, but is Node-only.
 *
 * Never throws, since a log call that throws loses the line and interrupts its
 * caller. A `%s`-style specifier is not substituted.
 */
export function formatLogArg(value: unknown, options: FormatLogArgOptions = {}): string {
   if (typeof value === 'string') {
      return value;
   }
   if (typeof value === 'object' && value !== null) {
      try {
         // `undefined` where `toJSON` returns nothing.
         const json: string | undefined =
            value instanceof Error ? undefined : JSON.stringify(value, boundedReplacer(options.indent), options.indent);
         if (json !== undefined) {
            return json;
         }
      } catch {
         // A throwing getter or `toJSON`, or a revoked proxy; described below instead.
      }
   }
   return describeErrorWithStack(value);
}

interface Visit {
   readonly parent: object;
   readonly depth: number;
   /** The object a cut copy stands in for, which a cycle refers back to. */
   readonly source: object;
}

function boundedReplacer(indent: number | undefined): (this: object, key: string, value: unknown) => unknown {
   // Keyed by the object last entered; JSON is written depth first, so its entry is on the path being written.
   const visits = new Map<object, Visit>();
   const isOnPath = (value: object, holder: object | undefined): boolean =>
      holder !== undefined && ((visits.get(holder)?.source ?? holder) === value || isOnPath(value, visits.get(holder)?.parent));
   // As `JSON.stringify` clamps its `space`.
   const space = Math.min(10, Math.max(0, Math.floor(indent ?? 0)));
   let remaining = LOG_ARG_LENGTH;
   let exhausted = false;
   return function (this: object, key: string, raw: unknown): unknown {
      if (exhausted) {
         // In an object the entry is left out; in an array it reads `null`.
         return undefined;
      }
      // A boxed primitive is written as its value, so it is cut as one.
      const value = raw instanceof String || raw instanceof Number || raw instanceof Boolean || raw instanceof BigInt ? raw.valueOf() : raw;
      const depth = (visits.get(this)?.depth ?? -1) + 1;
      const rendered = render(value, depth, this);
      const isObject = typeof rendered === 'object' && rendered !== null;
      // What this entry writes: its value, its key unless it is an item, and the punctuation and indent around them.
      const written = isObject ? undefined : JSON.stringify(rendered);
      // A value JSON cannot write is left out of an object, key and all, and written as `null` in an array.
      const leftOut = !isObject && written === undefined && !Array.isArray(this);
      const valueLength = isObject ? 2 : (written?.length ?? 4);
      const keyLength = depth === 0 || Array.isArray(this) ? 0 : JSON.stringify(key).length + 1 + (space > 0 ? 1 : 0);
      const layoutLength = 1 + (space > 0 ? (1 + space * depth) * (isObject ? 2 : 1) : 0);
      const length = leftOut ? 0 : valueLength + keyLength + layoutLength;
      if (length > remaining) {
         exhausted = true;
         return '...';
      }
      remaining -= length;
      if (isObject) {
         visits.set(rendered, { parent: this, depth, source: value as object });
      }
      return rendered;
   };

   function render(value: unknown, depth: number, holder: object): unknown {
      if (typeof value === 'string') {
         return cutString(value);
      }
      if (typeof value === 'bigint') {
         return String(value);
      }
      if (typeof value !== 'object' || value === null) {
         return value;
      }
      if (isOnPath(value, holder)) {
         return '[Circular]';
      }
      if (depth > LOG_ARG_DEPTH) {
         return Array.isArray(value) || isTypedArray(value) ? '[Array]' : '[Object]';
      }
      return cut(value);
   }
}

function cutString(value: string): string {
   const more = value.length - LOG_ARG_STRING_LENGTH;
   return more > 0 ? `${value.slice(0, LOG_ARG_STRING_LENGTH)}... ${more} more characters` : value;
}

function isTypedArray(value: object): value is ArrayLike<unknown> {
   return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

/**
 * `value`, or a copy of its first {@link LOG_ARG_ITEMS} items or keys, keys cut
 * as strings are, with a note of how many more there are. A typed array is
 * copied to an array, which reads its items without listing its keys.
 */
function cut(value: object): object {
   if (Array.isArray(value) || isTypedArray(value)) {
      const more = value.length - LOG_ARG_ITEMS;
      const items = Array.from({ length: Math.min(value.length, LOG_ARG_ITEMS) }, (_, i) => value[i]);
      return more > 0 ? [...items, `... ${more} more items`] : Array.isArray(value) ? value : items;
   }
   // Linear in the keys: no API lists the first few alone, and `JSON.stringify` would list them all too.
   const keys = Object.keys(value);
   const more = keys.length - LOG_ARG_ITEMS;
   const kept = keys.slice(0, LOG_ARG_ITEMS);
   if (more <= 0 && kept.every(key => key.length <= LOG_ARG_STRING_LENGTH)) {
      return value;
   }
   // No prototype, so a `__proto__` key is an entry like any other.
   const copy: Record<string, unknown> = Object.create(null);
   // A cut key or the note can equal a key already written; numbered, so neither entry is lost.
   const add = (key: string, entry: unknown): void => {
      let unique = key;
      for (let i = 2; unique in copy; i++) {
         unique = `${key} (${i})`;
      }
      copy[unique] = entry;
   };
   for (const key of kept) {
      add(cutString(key), (value as Record<string, unknown>)[key]);
   }
   if (more > 0) {
      add(`... ${more} more keys`, '...');
   }
   return copy;
}
