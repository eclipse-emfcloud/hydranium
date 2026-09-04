/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Validates that a wire-name prefix — the `methodNamespace` option shared
 * by `bindRpcMethods` and
 * `createRpcProxy` — carries a
 * trailing `/`.
 *
 * **Why this exists.** Adopters reading the LSP-namespace analogy
 * (`textDocument/*`, `workspace/*`) naturally pass `'mylang'` expecting
 * `'mylang/getModelDocument'` on the wire. Concatenating verbatim instead
 * yields `'mylanggetModelDocument'`, and because the proxy and binding sites
 * pick the wrong prefix in lockstep the mismatch is silent on a single-process
 * adopter, audible only as a per-method "Unhandled method" on the wire log.
 *
 * Throwing is preferred over coercion: coercion would disguise the case where
 * the adopter intended a different separator (`'.'`, `':'`), and throwing at
 * construction time surfaces the bug at the adopter's own callsite rather than
 * at the first wire response.
 *
 * Accepts the empty string (explicit no-prefix mode) or any non-empty string
 * ending with `/`; anything else throws {@link TypeError} synchronously.
 *
 * @param methodNamespace The configured prefix (e.g. `'mylang/'`,
 *    `'data-server/'`, `''`).
 * @param caller Name of the validating function, embedded in the thrown
 *    message so the error reads as if it came from the adopter-facing
 *    function rather than this helper.
 */
export function assertValidMethodNamespace(methodNamespace: string, caller: string): void {
   if (methodNamespace === '' || methodNamespace.endsWith('/')) {
      return;
   }
   throw new TypeError(
      `${caller}: methodNamespace '${methodNamespace}' must end with '/' (or be empty). ` +
         "Adopters reading the LSP-namespace analogy ('textDocument/*', 'workspace/*') often " +
         `forget the trailing slash, producing wire names like '${methodNamespace}someMethod' ` +
         `that do not match handler bindings under '${methodNamespace}/someMethod'. ` +
         `Either pass '${methodNamespace}/' or use the empty string for no prefix.`
   );
}
