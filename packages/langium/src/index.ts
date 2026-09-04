/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `@hydranium/langium` — augmented re-export of the Langium API.
 *
 * This is the single chokepoint where the hydranium framework consumes
 * Langium: it pins the Langium version (one physical copy, guaranteed by
 * the root `overrides`/`resolutions`) and layers the framework's
 * type/namespace augmentations. Framework packages AND adopters import
 * Langium from here, not from `langium` directly — lint-enforced across
 * the `packages` and `examples` trees alike, with any `generated`
 * directory exempt because `langium-cli` emits direct imports there and
 * regenerates them on every build.
 *
 * **Why adopters too, and it is not runtime identity.** Re-export is
 * transparent: given one physical `langium`, importing a symbol from here
 * and from `langium` yields the same object and the same declaration. The
 * reason is VERSION COUPLING: `langium` sits in an atomic chain with
 * `vscode-languageserver` / `-protocol` / `-jsonrpc` (see the `//langium`
 * note in the root `package.json`), so an adopter importing it directly
 * owns that pin itself and can drift out of lockstep with the framework it
 * composes. Here, the framework owns it. This is also the place a Langium
 * rename would be defensively patched, which a direct importer does not
 * benefit from.
 *
 * The only curation is the ambient `$synthetic` `AstNode` widening and the
 * `UriUtils` helper namespace; everything else is passthrough.
 */

// Ambient type-level augmentation of `AstNode` ($synthetic marker).
import './augmentations/synthetic.js';
// Side-effecting runtime augmentation of the `UriUtils` namespace.
import './augmentations/uri-utils.js';

export * from 'langium';
