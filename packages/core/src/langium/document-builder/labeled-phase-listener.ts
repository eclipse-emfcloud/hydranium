/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A document-builder phase listener that carries a `displayName` so per-listener
 * timing can attribute slow-listener breakdowns to the right caller. The
 * framework's enhanced document-builder reads `displayName` when emitting
 * per-listener phase logs; listeners without a
 * label fall back to `Function.name`.
 */
export interface LabeledPhaseListener {
   displayName: string;
}

/** Attach a `displayName` to a phase listener so it shows up in slow-listener breakdowns. */
export function labelPhaseListener<T extends (...args: never[]) => unknown>(listener: T, displayName: string): T & LabeledPhaseListener {
   const labeled = listener as T & LabeledPhaseListener;
   labeled.displayName = displayName;
   return labeled;
}
