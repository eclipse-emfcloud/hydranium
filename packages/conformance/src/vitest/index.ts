/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The Vitest adapter for `@hydranium/conformance` — the Vitest sibling of the
 * `@hydranium/conformance/jest` adapter. It binds Vitest's `describe` / `it` /
 * `it.skip` / `afterAll` to the runner-agnostic {@link ConformanceRunner} port
 * and exposes the `run{Data,Lsp,Glsp}Conformance` entry points an
 * adopter-on-Vitest calls, each building its slice's pure check list and
 * emitting it through the bound runner. The core (`.` / `/data` / `/lsp` /
 * `/glsp`) imports no runner and asserts with `node:assert`; the
 * `@hydranium/conformance/jest` sibling is this same binding against Jest's
 * globals.
 *
 * Adopters import the `run*` functions AND the slice types from here, so a
 * Vitest-based suite needs a single import site.
 */

import type { TransferDiagnostic, TransferElement } from '@hydranium/protocol';
import { afterAll, describe, it } from 'vitest';
import { type ConformanceRunner, emitConformanceSuite } from '../conformance-suite.js';
import { buildDataChecks, type DataConformanceOptions } from '../data/index.js';
import { buildLspChecks, type LspConformanceOptions } from '../lsp/index.js';
import { buildGlspChecks, type GlspConformanceDriver, type GlspConformanceOptions } from '../glsp/index.js';

// Re-export the per-head public types so an adopter imports `run*` + the
// fixture / driver-port / options types it needs from this one subpath.
export type { DataConformanceDriver, DataConformanceOptions } from '../data/index.js';
export type {
   LspConformanceCompletionList,
   LspConformanceDiagnostic,
   LspConformanceDriver,
   LspConformanceInitializeResult,
   LspConformanceOptions
} from '../lsp/index.js';
export type { GlspConformanceDriver, GlspConformanceOptions, GlspCreateOperationSpec, GlspFixture } from '../glsp/index.js';

/** Vitest bound to the kit's runner-agnostic {@link ConformanceRunner} port. */
const vitestRunner: ConformanceRunner = {
   describe: (name, register) => describe(name, register),
   test: (name, body) => it(name, body),
   skip: name => it.skip(name, () => undefined),
   afterAll: fn => afterAll(fn)
};

/**
 * Run the data-server conformance battery against an adopter's live server
 * under Vitest. Emits a `describe` with one `it` per check (server-level once,
 * grammar-bearing per language) and a ran-vs-skipped summary.
 */
export function runDataConformance<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic = TransferDiagnostic>(
   options: DataConformanceOptions<TTransfer, TDiagnostic>
): void {
   emitConformanceSuite(vitestRunner, options.suiteTitle ?? 'conformance: data-server', buildDataChecks(options));
}

/**
 * Run the LSP conformance battery against an adopter's live server under Vitest.
 * Emits a `describe` with one `it` per check (server-level once, grammar-bearing
 * per language) and a ran-vs-skipped summary.
 */
export function runLspConformance(options: LspConformanceOptions): void {
   emitConformanceSuite(vitestRunner, options.suiteTitle ?? 'conformance: lsp', buildLspChecks(options));
}

/**
 * Run the GLSP conformance battery against an adopter's live diagram server
 * under Vitest. Emits a `describe` with one `it` per check (per diagram type)
 * and a ran-vs-skipped summary.
 */
export function runGlspConformance<TAction, TDriver extends GlspConformanceDriver<TAction>>(
   options: GlspConformanceOptions<TAction, TDriver>
): void {
   emitConformanceSuite(vitestRunner, options.suiteTitle ?? 'conformance: glsp', buildGlspChecks(options));
}
