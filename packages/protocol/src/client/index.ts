/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Subpath barrel for `@hydranium/protocol/client` — the **host-neutral client
 * tier** of the data head.
 *
 * Where `./data` is the wire *contract* and `./rpc` is the machinery that lowers
 * it onto a connection, this is what a client wraps around both: the seam a host
 * fills in (`DataPort`), the lifecycle above it (`DataSession` —
 * readiness gate, open/watch ordering, echo recognition, reconnect), the inbound
 * fan-out (`DataEvents`), and the two halves of the hop for hosts whose
 * client cannot hold a socket — `createPostMessageTransport` on the client
 * side and `relayToPostMessageChannel` on the side that does hold it.
 *
 * **Neutral, and gate-enforced so.** Nothing here imports a host package or a
 * Node builtin, which is what lets one client tier serve a Theia frontend, a VS
 * Code extension host, a VS Code webview and a plain browser app. `npm run
 * check:neutral` bundles these modules for the browser; `scripts/check-neutral-bundles.mjs`
 * carries the entries.
 *
 * The Theia-specific mounting of the same contract lives in
 * `@hydranium/data-client-theia`: its `AbstractDataServiceFrontend` solves the
 * same problem against Theia's channel transport, and its `EmitterDataClient`
 * is the Theia-bound counterpart of `DataEvents`. Prefer this tier for
 * anything new, and reach for the Theia package only for what genuinely needs
 * Theia DI.
 */

export * from './data-events';
export * from './data-port';
export * from './data-session';
export * from './message-relay';
export * from './post-message-transport';
