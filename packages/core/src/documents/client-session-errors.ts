/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Thrown by every call on a client session after it ended, and by an open that
 * was still in flight when its session ended.
 *
 * The message names the client id, so it is addressed to whoever composes the
 * system rather than to an end user.
 */
export class SessionClosedError extends Error {
   constructor(readonly clientId: string) {
      super(`Client session ${clientId} is closed`);
      this.name = 'SessionClosedError';
   }
}

/**
 * Thrown when a client session writes a document it does not have open.
 *
 * A session writes only what it has open, so this is the answer both to a write
 * that never opened and to one whose open was closed underneath it — by the
 * session itself, or by the document being deleted.
 */
export class DocumentNotOpenError extends Error {
   constructor(
      readonly uri: string,
      readonly clientId: string
   ) {
      super(`Document ${uri} is not open in client session ${clientId}`);
      this.name = 'DocumentNotOpenError';
   }
}

/**
 * Thrown when a client session is started under an id that is already live in
 * the process, or that the framework reserves for itself.
 *
 * Ids are unique process-wide because the id is also the author label on every
 * version and the key a client recognises its own echoes by; two participants
 * sharing one would each take the other's writes for their own.
 */
export class DuplicateClientIdError extends Error {
   constructor(readonly clientId: string) {
      super(`Client id ${clientId} is already in use`);
      this.name = 'DuplicateClientIdError';
   }
}
