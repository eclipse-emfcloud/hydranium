/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Declared field by field rather than extending GLSP's action types, as the
// save actions are: this package carries no GLSP dependency.

/**
 * A request the server answers, with an {@link EditsSettledAction}, once every
 * edit the client sent before it has been handled and its text has reached
 * the language client, so the client knows those edits are answered.
 *
 * An operation has no answer of its own: the server replies with a model
 * update and a dirty state, with a message, or with nothing at all when the
 * operation changed nothing. The server handles a client's actions one at a
 * time, so a request sent after the edits is answered after them, whatever
 * each one answered. A server that fails it answers with a GLSP
 * `RejectAction`, which ends the wait too.
 */
export interface RequestEditsSettledAction {
   /** Answered only by a server that advertises this kind. The framework's dispatcher sends none to a server that does not. */
   kind: typeof RequestEditsSettledAction.KIND;
   /** The id the response echoes as its `responseId`. Empty until the dispatcher assigns one. */
   requestId: string;
   /**
    * How long the server waits before it rejects the request, as it does any
    * request; a rejection then means not settled, and the answer that follows
    * is dropped. GLSP's `requestUntil` sets one; `request` leaves it unset.
    */
   timeout?: number;
   /** GLSP's typing marker for the response. Never set. */
   readonly _?: EditsSettledAction;
}

export namespace RequestEditsSettledAction {
   export const KIND = 'hydraniumRequestEditsSettled';

   export function create(options: { requestId?: string } = {}): RequestEditsSettledAction {
      return { kind: KIND, requestId: '', ...options };
   }
}

/** The server's answer to a {@link RequestEditsSettledAction}. */
export interface EditsSettledAction {
   /** No client handler takes this kind: the dispatcher settles the request by {@link responseId} instead. */
   kind: typeof EditsSettledAction.KIND;
   /** The `requestId` of the request this answers. The server's dispatcher sets it. */
   responseId: string;
}

export namespace EditsSettledAction {
   export const KIND = 'hydraniumEditsSettled';

   export function create(options: { responseId?: string } = {}): EditsSettledAction {
      return { kind: KIND, responseId: '', ...options };
   }
}
