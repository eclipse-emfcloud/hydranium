/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Subpath barrel for the in-process `ModelService` facade contract. The
// implementation lives in `@hydranium/core`; this package owns the
// argument types so both the framework facade and the data-server wire
// protocol can structurally agree on the lifecycle shape.

export * from './args';
export * from './reference-candidate';
