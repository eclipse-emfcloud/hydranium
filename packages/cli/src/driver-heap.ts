/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { heapCeilingArgs } from '@hydranium/core/node';

/**
 * Heap ceiling in MiB for a driver child on a machine with no cgroup limit.
 *
 * The subcommands that spawn one build a whole workspace in that child —
 * `measure-memory` deliberately so, `analyze-heap` loads an entire heap
 * snapshot — so the default Node would pick from physical RAM is too low for
 * the workspaces these are pointed at.
 */
export const DRIVER_HEAP_MB = 8192;

/** Environment variable an operator raises or lowers {@link driverHeapArgs} with. */
export const DRIVER_HEAP_ENV = 'HYDRANIUM_CLI_MAX_OLD_SPACE_MB';

/**
 * Smallest ceiling {@link DRIVER_HEAP_ENV} may state. A driver child builds a
 * whole workspace, so a value this far below the default is a unit mistake
 * rather than a deliberate squeeze.
 */
export const MIN_DRIVER_HEAP_MB = 256;

/**
 * A cgroup reading, so a caller — in practice a test — can decide the ceiling
 * instead of inheriting the machine's. Omitted fields fall back to this
 * process's own reading.
 */
export interface HeapReading {
   readonly constrained?: number;
   readonly total?: number;
}

/**
 * The `execArgv` prefix every driver child is spawned under.
 *
 * Inside a container this is EMPTY on purpose. {@link DRIVER_HEAP_MB} is sized
 * for a workstation, and handing it to a process under a smaller cgroup limit
 * is worse than handing it nothing: V8 has no reason to collect hard below a
 * ceiling it will never reach, so the kernel OOM-kills the container first and
 * the failure arrives as a signal against the whole cgroup rather than as a
 * heap error the parent can attribute. Left to itself, Node sizes the heap from
 * the limit instead.
 *
 * That trades away the ability to use a LARGE container's memory, since Node's
 * derived default is a fraction of the limit — which is what {@link DRIVER_HEAP_ENV}
 * is for. An operator who states a number has decided, so it wins in a
 * container too.
 */
export function driverHeapArgs(reading: HeapReading = {}): string[] {
   return heapCeilingArgs({
      desktopDefaultMb: DRIVER_HEAP_MB,
      envValue: process.env[DRIVER_HEAP_ENV],
      minMb: MIN_DRIVER_HEAP_MB,
      ...reading
   });
}
