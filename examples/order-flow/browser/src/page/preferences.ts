/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Where the page remembers a reader's language and colour scheme.
 *
 * Both follow one chain: an explicit URL parameter, then the store, then the
 * environment. The explicit tier is what keeps a shared link deterministic.
 *
 * A refusal here falls through silently, unlike the workspace store: losing a
 * scheme costs nothing the environment cannot answer for.
 */

/** The preferences this page remembers, namespaced against anything else on the origin. */
const KEYS = {
   locale: 'order-flow.locale',
   scheme: 'order-flow.scheme'
} as const;

export type PreferenceName = keyof typeof KEYS;

/**
 * The store, or `undefined` where the browser denies one.
 *
 * A function rather than a constant: merely NAMING `localStorage` throws where
 * a site is denied storage, and at import time nothing can yet carry on without
 * it.
 */
function store(): Storage | undefined {
   try {
      return window.localStorage;
   } catch {
      return undefined;
   }
}

/**
 * What was stored for `name`, or `undefined` if nothing was.
 *
 * An empty string is a VALUE: it is how the locale records English, which the
 * URL spells by having no parameter at all.
 */
export function storedPreference(name: PreferenceName): string | undefined {
   try {
      return store()?.getItem(KEYS[name]) ?? undefined;
   } catch {
      return undefined;
   }
}

/** Remember `value` for `name`, or carry on unremembered where storage refuses. */
export function rememberPreference(name: PreferenceName, value: string): void {
   try {
      store()?.setItem(KEYS[name], value);
   } catch {
      // Denied, full, or in a private window that allows the read and refuses
      // the write. The page works either way; only the next visit differs.
   }
}
