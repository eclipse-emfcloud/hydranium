/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The shared path identifier under which the data-server exposes its typed
 * RPC methods. Production adopters using vscode-jsonrpc transports use this
 * as the connection-builder path; the data-server side uses it when
 * registering handlers.
 *
 * Distinct from the LSP (`languageId`-routed) and GLSP (`diagram-type`-routed)
 * heads — each protocol head owns its own path namespace.
 */
export const DATA_SERVER_PATH = '/hydranium/data-server';

/**
 * Wire-name prefix used by `createRpcProxy` and `DataServer`'s
 * handler binding. Every property name on the typed `DataServerProtocol`
 * (or `DataClientProtocol`) interface lowers to `<prefix><methodName>` on
 * the wire — so renaming a TS method renames the wire method,
 * intentionally.
 *
 * Adopters writing custom transports or inspecting the wire derive each
 * wire name as `DATA_SERVER_WIRE_PREFIX + methodName`, where the method
 * names live in `DATA_SERVER_PROTOCOL_METHODS` (request methods) and
 * `DATA_CLIENT_PROTOCOL_METHODS` (notification methods), both exported
 * from `./data-protocol-methods`. The interface (`DataServerProtocol`,
 * `DataClientProtocol`) is the source of truth; the method-name arrays
 * are typed against the interface (`as const satisfies …`) so they
 * cannot drift.
 */
export const DATA_SERVER_WIRE_PREFIX = 'data-server/';

/**
 * Default LSP command id under which a data-server publishes its listening
 * TCP port for client discovery. Parallel to {@link DATA_SERVER_PATH} (the
 * service-path routing constant) — both name the data-server head's transport
 * surface so a simple adopter needs no constants of its own.
 *
 * Two ends reference this id:
 * - PUBLISH (server): the launcher registers the port under this command on
 *   the LSP connection —
 *   `publishPortOnLspConnection(conn, DATA_SERVER_PORT_COMMAND, port)`.
 *   `@hydranium/core`'s `publishPortOnLspConnection` stays command-agnostic
 *   (it publishes any port under any command); the adopter passes this
 *   constant.
 * - EXTRACT (Theia host): `@hydranium/data-client-theia`'s
 *   `DataServerConnectionHandler` polls this command to discover the port —
 *   its `portCommand` option defaults to this value.
 *
 * Adopters with an established command id (e.g. `'modelserver:port'`)
 * override both ends.
 */
export const DATA_SERVER_PORT_COMMAND = 'hydranium/data-server/port';
