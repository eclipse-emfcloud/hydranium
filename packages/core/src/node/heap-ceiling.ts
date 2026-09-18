/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Choosing `--max-old-space-size` for a child process, which is a decision no
 * caller gets right by picking a number.
 *
 * A fixed ceiling is sized for the machine the author had. Pass 8192 to a
 * process under a 2 GiB cgroup limit and V8 lets old space grow past the limit
 * without ever collecting hard, so the kernel OOM-kills the whole container
 * before V8 has any reason to act — the parent sees a signal, not a heap error,
 * and everything sharing the cgroup dies with it. Pass nothing on a large
 * desktop and V8 sizes from physical RAM, which for a memory-heavy tool is well
 * under what it needs.
 *
 * Both are the same mistake: a ceiling stated without reference to the limit
 * that is actually in force. The rule here is to name the desktop default
 * explicitly and step aside inside a container, where Node derives its own
 * ceiling from the cgroup limit and a runaway heap therefore fails INSIDE the
 * child — attributable, and reported as a heap error against one process rather
 * than as a kill against every process in the cgroup.
 */

import * as os from 'node:os';

/** Options for {@link heapCeilingArgs}. */
export interface HeapCeilingOptions {
   /**
    * Ceiling in MiB to pass when no cgroup limit is in force. Name the value a
    * memory-heavy run on a workstation needs; it is ignored inside a container.
    */
   readonly desktopDefaultMb: number;
   /**
    * Caller-supplied override, typically an environment variable, and typically
    * `undefined`. A finite value at or above {@link minMb} wins everywhere,
    * container or not — an operator who states a number has decided. An explicit
    * `0` means "let Node decide" and emits no flag. Anything unparseable is
    * REPORTED through {@link warn} rather than ignored: `8G` is a natural thing
    * to type into a variable measured in MiB, and silently dropping it leaves
    * the operator believing a ceiling is in force.
    */
   readonly envValue?: string;
   /**
    * Smallest override to pass on. Below it, {@link warn} is called and NO flag
    * is emitted: a value that small can only be a misconfiguration — GiB typed
    * where MiB was meant — and V8 fatals at startup once it is small enough.
    * Deliberately not clamped UP: running with a different number than the one
    * configured hides the mistake instead of surfacing it. Omitted means no floor.
    */
   readonly minMb?: number;
   /** Where a rejected override is reported. Defaults to `console.warn`. */
   readonly warn?: (message: string) => void;
   /** Cgroup limit in bytes; defaults to this process's. Injectable for tests. */
   readonly constrained?: number;
   /** Host physical memory in bytes; defaults to `os.totalmem()`. Injectable for tests. */
   readonly total?: number;
}

/**
 * Whether a cgroup memory limit is in force — i.e. whether the OOM killer is
 * watching a ceiling lower than (or equal to) the machine's own.
 *
 * **`constrained > 0` is not the test, and that is the whole reason this is a
 * named function.** With no limit set, cgroup v2 reports 2^64 and v1 reports
 * ~2^63 rather than 0, so the naive test reads every desktop as a container.
 * Neither sentinel can equal `os.totalmem()`, so comparing against the host
 * total costs nothing and rules both out. The comparison is `<=` rather than
 * `<` so a limit set to exactly the host's RAM still counts as a limit.
 */
export function isMemoryConstrained(constrained = process.constrainedMemory?.() ?? 0, total = os.totalmem()): boolean {
   return constrained > 0 && constrained <= total;
}

/**
 * The `execArgv` entries that set a child's heap ceiling: `[]` to let Node size
 * the heap itself, or a single `--max-old-space-size=<mb>`.
 *
 * Returns an array rather than a string so a caller can spread it
 * unconditionally into an argv it is building.
 */
export function heapCeilingArgs(options: HeapCeilingOptions): string[] {
   const { desktopDefaultMb, envValue, minMb, warn = (message: string) => console.warn(message) } = options;
   if (envValue !== undefined) {
      const mb = Number(envValue);
      // An explicit 0 is a decision — "let Node decide" — so it passes quietly.
      // Anything else that is not a positive number is a typo, and the operator
      // who typed it is the one person who cannot tell it was dropped.
      if (!Number.isFinite(mb) || mb < 0) {
         warn(`Ignoring the heap ceiling '${envValue}': expected a whole number of MiB. Node will size the heap instead.`);
         return [];
      }
      if (mb === 0) {
         return [];
      }
      if (minMb !== undefined && mb < minMb) {
         warn(`Ignoring a heap ceiling of ${envValue} MiB: below the ${minMb} MiB minimum. Node will size the heap instead.`);
         return [];
      }
      return [`--max-old-space-size=${Math.floor(mb)}`];
   }
   return isMemoryConstrained(options.constrained, options.total) ? [] : [`--max-old-space-size=${desktopDefaultMb}`];
}
