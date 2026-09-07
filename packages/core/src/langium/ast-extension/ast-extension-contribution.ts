/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNode } from '@hydranium/langium';
import { type Disposable } from 'vscode-languageserver';
import { type AstExtension } from './ast-extension-service.js';

/**
 * Registry handed to an {@link AstExtensionContribution}. Implemented by the
 * AST-extension service; a contribution receives it and registers one or many
 * AST extensions (build-phase computed / synthetic properties). Doubles as
 * the low-level imperative API.
 */
export interface AstExtensionRegistry {
   register<T extends AstNode>(extension: AstExtension<T>): Disposable;
}

/**
 * Declarative registration of AST extensions. Bound under the module's
 * `ast.extensions` contribution group; the AST-extension service reads that
 * group at construction and calls this method, handing itself in as the
 * registry.
 *
 * The domain-qualified method name lets a single cross-cutting class implement
 * several contribution interfaces without method collision.
 */
export interface AstExtensionContribution {
   registerAstExtensions(registry: AstExtensionRegistry): void;
}
