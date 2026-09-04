/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Disposable } from 'vscode-languageserver';
import { type ScopeExtension } from './scope-extension-service.js';

/**
 * Registry handed to a {@link ScopeExtensionContribution}. Implemented by the
 * scope-extension service; a contribution receives it and registers one or
 * many scope extensions (extra resolvable descriptions layered on top of the
 * `getScope` result). Doubles as the low-level imperative API.
 */
export interface ScopeExtensionRegistry {
   register(extension: ScopeExtension): Disposable;
}

/**
 * Declarative registration of scope extensions. Bound under the module's
 * `references.scopes` contribution group; the scope-extension service reads
 * its own group at construction and calls this method, handing itself in as
 * the registry.
 *
 * The domain-qualified method name lets a single cross-cutting class implement
 * several contribution interfaces without method collision.
 */
export interface ScopeExtensionContribution {
   registerScopeExtensions(registry: ScopeExtensionRegistry): void;
}
