/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Declared field by field rather than extending GLSP's action types: this
// package carries no GLSP dependency, and both GLSP heads already depend on it.
// The fields are GLSP's own, so both actions are assignable to GLSP's
// `RequestAction` and `ResponseAction`.

/**
 * A save of a diagram's model that the server answers, with a
 * {@link ModelSavedAction} once the save has finished or a GLSP
 * `RejectAction` when it fails.
 *
 * It carries what GLSP's `SaveModelAction` carries, and the server saves it the
 * same way. GLSP's `SaveModelAction` is not answered: the server's only
 * reply is a dirty-state change, which the client drops when the dirty flag
 * does not change, so a client cannot tell which save an answer belongs to or
 * whether a save failed.
 */
export interface RequestSaveModelAction {
   kind: typeof RequestSaveModelAction.KIND;
   /** The id the response echoes as its `responseId`. Empty until the dispatcher assigns one. */
   requestId: string;
   /** How long the receiver waits for its own handler, in milliseconds. */
   timeout?: number;
   /** The file to save to, as in GLSP's `SaveModelAction`; absent saves to the diagram's source. */
   fileUri?: string;
   /** GLSP's typing marker for the response. Never set. */
   readonly _?: ModelSavedAction;
}

export namespace RequestSaveModelAction {
   export const KIND = 'hydraniumRequestSaveModel';

   export function create(options: { fileUri?: string; requestId?: string } = {}): RequestSaveModelAction {
      return { kind: KIND, requestId: '', ...options };
   }
}

/** The server's answer to a {@link RequestSaveModelAction} that saved. */
export interface ModelSavedAction {
   kind: typeof ModelSavedAction.KIND;
   /** The `requestId` of the save this answers. The server's dispatcher sets it. */
   responseId: string;
}

export namespace ModelSavedAction {
   export const KIND = 'hydraniumModelSaved';

   export function create(options: { responseId?: string } = {}): ModelSavedAction {
      return { kind: KIND, responseId: '', ...options };
   }
}
