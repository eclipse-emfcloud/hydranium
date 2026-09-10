/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The message-externalization mechanism, plus every user-facing message
 * `@hydranium/protocol` itself raises.
 *
 * Declarations stay beside their call sites and are re-exported here, so this is
 * enumeration rather than centralization: a code's package segment has to name
 * the package that raises it, and a shared module would make that segment a lie
 * for every message in it. Adding a message therefore touches the file that
 * raises it and this list, and nothing else.
 *
 * A barrel makes every code and English default public API, so renaming a code
 * is a breaking change. That was already true — an adopter's catalogue keys on
 * these codes either way — but it is now in the type system rather than implicit.
 * The English is a fallback, not a contract; the code is the contract.
 */

export * from './primitives';

export { STALE_BASED_UPDATE } from '../errors';
export { DATA_SERVER_CONNECT_FAILED, DATA_SERVER_NOT_READY } from '../client/data-session';
export {
   RELAY_REPLAY_FAILED,
   RELAY_TRANSPORT_OPEN_FAILED,
   RELAY_TRANSPORT_READ_FAILED,
   RELAY_TRANSPORT_WRITE_FAILED
} from '../client/message-relay';
