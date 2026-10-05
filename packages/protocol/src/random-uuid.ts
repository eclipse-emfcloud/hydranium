/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A random v4 UUID. Not `crypto.randomUUID`: a browser offers it only in a
 * secure context, and a client may be served over plain HTTP.
 */
export function randomUuid(): string {
   const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
   // Version 4, RFC 4122 variant.
   bytes[6] = (bytes[6] & 0x0f) | 0x40;
   bytes[8] = (bytes[8] & 0x3f) | 0x80;
   const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
   return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
