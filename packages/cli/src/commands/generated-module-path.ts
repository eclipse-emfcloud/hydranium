/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as path from 'path';

/**
 * Module specifier for `targetFile` as seen from the generated module
 * `outFile`'s own directory. Emitted with a `.js` extension and posix
 * separators because the output is ESM TypeScript, where the specifier names
 * the compiled sibling.
 */
export function relativeImportPath(outFile: string, targetFile: string): string {
   const relative = path.relative(path.dirname(path.resolve(outFile)), path.resolve(targetFile));
   const posix = relative.split(path.sep).join('/').replace(/\.ts$/, '.js');
   return posix.startsWith('.') ? posix : `./${posix}`;
}
