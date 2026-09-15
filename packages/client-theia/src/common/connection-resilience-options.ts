/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Options for the `bindConnectionResilience` helper each tier exports.
 *
 * Lives in `common` rather than beside either helper so the server entry can
 * name the type without importing the browser module, and the other way round.
 */
export interface ConnectionResilienceOptions {
   /**
    * Size of the buffer holding messages while the socket is down, in bytes.
    * Defaults to Theia's own limit. It decides how long an outage can last
    * before changes start being rejected, so a deployment on a poor network
    * trades memory for tolerance here.
    */
   readonly bufferBytes?: number;
}
