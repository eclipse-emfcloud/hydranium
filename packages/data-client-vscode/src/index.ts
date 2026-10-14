/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Neutral: the messenger channel both ends of the hop build on, free of
// `vscode`, Node and the DOM. The extension host's end is `./node`, the
// webview's `./browser`.
export * from './messenger-channel';
