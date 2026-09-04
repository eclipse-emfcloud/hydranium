/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { DataServerDiagnosticsProvider } from './diagnostics-provider.js';
import { nodeDataServerDiagnostics } from './node/node-diagnostics-provider.js';

/**
 * Platform default for `DataServerOptions.diagnostics` — the Node one.
 *
 * # This file is swapped by the bundler, and that is the whole mechanism
 *
 * `package.json`'s `browser` field maps this module to
 * `default-diagnostics.browser.js`, so a `platform: 'browser'` bundler never
 * resolves it and never follows its `@hydranium/core/node` import. Node keeps
 * it, because Node ignores the `browser` field.
 *
 * The alternative — reaching for the Node implementation directly from the head
 * — is what made this package unbundleable for a browser: a static
 * `@hydranium/core/node` import on the portable entry pulls `node:fs`,
 * `node:v8` and `node:perf_hooks` into any browser build, over methods a
 * browser cannot call.
 *
 * **`check:neutral` proves the swap works**, since it bundles this package's `.`
 * entry for the browser and would fail on those imports if the mapping ever
 * stopped applying. That is the same property the gate relies on for
 * `@eclipse-glsp/server`, whose own `browser` field selects its node-free
 * build.
 *
 * A host that wants to be explicit — or to supply its own — passes
 * `diagnostics` and this default is not consulted.
 */
export function defaultDataServerDiagnostics(): DataServerDiagnosticsProvider {
   return nodeDataServerDiagnostics();
}
