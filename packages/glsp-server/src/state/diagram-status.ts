/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ProposalString, SeverityLevel } from '@eclipse-glsp/server';

/**
 * Why a diagram is in a state its client has to show: the key an entry is set
 * and withdrawn under in {@link AbstractHydraniumGlspState.setStatus}.
 *
 * Open, as GLSP's `EditMode` is: an adopter keys its own statuses with any
 * other string. Each writer withdraws only its own key, so no writer clears a
 * status another one still holds.
 */
export const DiagramStatus = {
   /** The document does not parse, so the canvas refuses edits until it does. */
   PARSE_ERROR: 'parse-error',
   /** Live validation of the model is running. */
   VALIDATION: 'validation',
   /** The source model is loading. */
   MODEL_LOAD: 'model-load',
   /** The client asked for the diagram to be read-only. */
   CLIENT_REQUEST: 'client-request'
} as const;

export type DiagramStatus = ProposalString<(typeof DiagramStatus)[keyof typeof DiagramStatus]>;

/** What an active {@link DiagramStatus} does to the diagram. */
export interface DiagramStatusEntry {
   /** Shown in the client's status overlay; omitted when the status has nothing to say. */
   readonly message?: string;
   /** Picks which message is shown when several statuses carry one; the most recently set wins a tie. */
   readonly severity?: Exclude<SeverityLevel, 'NONE' | 'OK'>;
   /** Blocks editing while the status is active. */
   readonly readonly?: boolean;
}
