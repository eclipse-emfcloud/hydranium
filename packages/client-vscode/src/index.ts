/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Nothing here is neutral yet: every export needs the extension host and sits
// behind `./node`, so a webview bundle importing the bare specifier pulls in
// neither `vscode` nor Node.
export {};
