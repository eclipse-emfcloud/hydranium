/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Environment-agnostic shared surface for the data-server-head Theia
// integration. A module lands here only when its whole dependency closure —
// values, types and relative imports alike — is either neutral or Theia's
// COMMON tier; `@theia/core`'s root entry is that tier, while anything reaching
// `@theia/*/lib/browser` or `/lib/node` belongs in the tier it names, even when
// the import is type-only and erases at runtime.
//
// This tier deliberately holds no error-reconstruction bridge, and that is a
// property of the transport rather than an omission: the direct vscode-jsonrpc
// connection carries a typed error such as `ConflictError` across the channel
// relay natively, with no Theia msgpack hop to drop its data.
export * from './emitter-data-client';
