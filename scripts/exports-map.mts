/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** One key of a package's `exports` field, as the gates read it. */
export interface ExportEntry {
   key: string;
   /** A `null` value, which blocks the subpath and names no artefact. */
   blocked: boolean;
   /** The files the key can load at runtime, sorted and without repeats. */
   runtimePaths: string[];
   /** The declaration files the key names, sorted and without repeats. */
   typePaths: string[];
}

/**
 * Every key of an `exports` field, with its conditions flattened at any depth
 * and in any order. A string or a conditions object at the top level is the
 * `.` entry, as Node reads it. Every gate reads maps through this, so no two
 * gates disagree on what a value means.
 */
export function readExports(exportsField: unknown): ExportEntry[] {
   if (exportsField === undefined) {
      return [];
   }
   const subpaths = isSubpathMap(exportsField) ? exportsField : { '.': exportsField };
   return Object.entries(subpaths).map(([key, value]) => {
      const paths = targetPaths(value);
      return {
         key,
         blocked: value === null,
         runtimePaths: [...new Set(paths.filter(path => !isDeclarationFile(path)))].sort(),
         typePaths: [...new Set(paths.filter(isDeclarationFile))].sort()
      };
   });
}

function isSubpathMap(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).some(key => key.startsWith('.'));
}

function isDeclarationFile(path: string): boolean {
   return /\.d\.[cm]?ts$/.test(path);
}

function targetPaths(value: unknown): string[] {
   if (typeof value === 'string') {
      return [value];
   }
   if (value === null || typeof value !== 'object') {
      return [];
   }
   return Object.values(value).flatMap(targetPaths);
}
