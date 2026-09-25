/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Re-export, because these errors cross the wire and the side that has to
 * recognise them is the client. They are defined in `@hydranium/protocol` so a
 * frontend can name them without depending on the server tier.
 */
export {
   DocumentNotOpenError,
   DuplicateClientIdError,
   SessionClosedError,
   isDocumentNotOpenError,
   isDuplicateClientIdError,
   isSessionClosedError
} from '@hydranium/protocol';
