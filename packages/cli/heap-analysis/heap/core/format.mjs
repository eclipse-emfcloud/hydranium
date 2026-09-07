/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/* Tiny formatting helpers shared by the report renderers. */

export const mb = bytes => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Adaptive byte size: MB for ≥1 MB, KB for ≥1 KB, else bytes. Keeps sub-MB table
 * rows rankable instead of collapsing dozens of them to `0.0 MB`.
 */
export const humanBytes = bytes => {
   const abs = Math.abs(bytes);
   if (abs >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
   }
   if (abs >= 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
   }
   return `${Math.round(bytes)} B`;
};

export const pct = (part, whole) => (whole ? ((part / whole) * 100).toFixed(1) : '0.0') + '%';

/** Wall-clock `[HH:MM:SS]` stamp for progress lines on long-running work. */
export const nowStamp = () => `[${new Date().toTimeString().slice(0, 8)}]`;

/** Emit a timestamped progress line to stderr (keeps stdout clean for results). */
export function progress(message) {
   process.stderr.write(`${nowStamp()} ${message}\n`);
}

/** Render rows [label, count, sizeBytes, ...extra] as an aligned table. */
export function sizeTable(rows, { totalShallow } = {}) {
   const lines = [];
   for (const [label, count, size] of rows) {
      const share = totalShallow ? `  ${pct(size, totalShallow).padStart(6)}` : '';
      lines.push(`${mb(size).padStart(10)}${share}  ${String(count).padStart(10)}  ${label}`);
   }
   return lines.join('\n');
}
