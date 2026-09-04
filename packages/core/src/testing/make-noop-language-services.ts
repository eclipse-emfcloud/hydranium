/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ServerLanguageServices } from '../langium/language-module.js';
import { makeNoopSharedServices, type NoopSharedServicesOverrides } from './make-noop-shared-services.js';

/**
 * Overrides for {@link makeNoopLanguageServices}. `shared` flows into
 * {@link makeNoopSharedServices} (so the shared tree gets its no-op defaults);
 * every other key is a loosely-typed per-language slot group (`references`,
 * `ast`, `serializer`, `integrity`, `updateRewrite`, `validation`, the
 * language-level `workspace`, …) spread onto the result, so a test drops in the
 * one or two service stubs the class under test reads without a per-slot cast.
 */
export interface NoopLanguageServicesOverrides {
   /** Overrides for the `shared` sub-tree — forwarded to {@link makeNoopSharedServices}. */
   shared?: NoopSharedServicesOverrides;
   /** Any per-language slot the class under test reads. */
   [slot: string]: unknown;
}

/**
 * Build a {@link ServerLanguageServices} tree whose `shared` sub-tree carries
 * the {@link makeNoopSharedServices} no-op defaults, leaving the per-language
 * slots for the caller to fill through `overrides`.
 *
 * The single unavoidable cast — an assembled literal can't structurally satisfy
 * the full `ServerLanguageServices` (it omits the Langium per-language surface a
 * unit test doesn't touch) — is encapsulated here, so a test constructing a
 * framework per-language service (`DefaultIntegrityService`,
 * `DefaultAstExtensionService`, `DefaultScopeExtensionService`,
 * `DefaultUpdateRewriteService`, …) stays cast-free. The per-language sibling of
 * {@link makeNoopSharedServices}.
 */
export function makeNoopLanguageServices(overrides: NoopLanguageServicesOverrides = {}): ServerLanguageServices {
   const { shared, ...rest } = overrides;
   return {
      shared: makeNoopSharedServices(shared),
      ...rest
   } as unknown as ServerLanguageServices;
}
