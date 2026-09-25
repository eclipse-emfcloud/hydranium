/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { StubHydraniumTextDocuments } from '@hydranium/core/testing';

export interface SessionEnding {
   readonly clientId: string;
   readonly cause: unknown;
}

/**
 * Record each session end where it reaches the store, with its cause, and pass
 * it on. The cause decides whether a document the session was the last to have
 * open waits out the store's revert grace, so it is read at the store rather
 * than at the server.
 */
export function recordSessionEndings(textDocuments: Pick<StubHydraniumTextDocuments, 'closeSession'>): SessionEnding[] {
   const recorded: SessionEnding[] = [];
   const closeSession = textDocuments.closeSession.bind(textDocuments);
   textDocuments.closeSession = (clientId, cause) => {
      recorded.push({ clientId, cause });
      closeSession(clientId, cause);
   };
   return recorded;
}
