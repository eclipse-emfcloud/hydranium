/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The uniform contract every framework test harness satisfies. A harness is
 * a wired bundle around a system-under-test, driven through a seam; its full
 * shape is `{ <subject>, <seam>, …captureArrays, dispose() }`. This marker
 * pins the one member that is identical across every harness — `dispose()` —
 * so teardown is always `harness.dispose()` regardless of which harness, and
 * a `Harness` reference can release any of them without knowing its concrete
 * type. Each concrete harness interface — per head, and per conformance driver
 * port — `extends Harness` and adds its subject / seam / capture members on
 * top.
 */
export interface Harness {
   /** Release every resource the harness holds. Idempotent; the uniform teardown hook. */
   dispose(): void;
}
