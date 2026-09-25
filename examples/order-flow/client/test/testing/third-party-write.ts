/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { isDuplicateClientIdError, type TransferElement } from '@hydranium/protocol';

/** The part of the data head's wire a third-party write uses. */
export interface ThirdPartyWriteServer<TTransfer extends TransferElement> {
   createSession(args: { clientId: string }): Promise<void>;
   openModelDocument(args: { uri: string; clientId: string }): Promise<unknown>;
   updateModelDocument(args: { uri: string; clientId: string; model: TTransfer | string; basedOn: 'anything' }): Promise<unknown>;
}

/**
 * Write `model` to `uri` as `clientId`, a participant other than the session
 * under test, ungated so it always lands.
 *
 * The server writes only as a client session, and only a document the session
 * has open, so the writer registers under `clientId` and opens `uri` first. An
 * id already registered is its own earlier registration on the same server,
 * which the suites keep for the life of the server. The open is left in place:
 * closing it could be the document's last close, which reverts it to disk.
 */
export async function thirdPartyWrite<TTransfer extends TransferElement>(
   server: ThirdPartyWriteServer<TTransfer>,
   clientId: string,
   uri: string,
   model: TTransfer | string
): Promise<void> {
   await server.createSession({ clientId }).catch((error: unknown) => {
      if (!isDuplicateClientIdError(error)) {
         throw error;
      }
   });
   await server.openModelDocument({ uri, clientId });
   await server.updateModelDocument({ uri, clientId, model, basedOn: 'anything' });
}
