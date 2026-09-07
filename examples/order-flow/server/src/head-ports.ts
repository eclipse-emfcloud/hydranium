/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The LSP requests a host queries to discover this server's two socket heads.
 *
 * Both are **project-keyed, not language-keyed**: one data server and one GLSP
 * server per process serve every registered grammar, so a language-derived name
 * would tie a project-level endpoint to whichever grammar was scaffolded first.
 *
 * They live here rather than in `main.ts` because a host shell has to name the
 * same string to reach the head, and `main.ts` is an executable entry — nothing
 * can import from it. A shell that retypes the literal gets no error when it
 * drifts: `AbstractSocketForwardingConnectionHandler` polls with `findPortAttempts = -1`
 * by default, so a wrong command retries forever rather than failing. Import
 * these instead, and assert any host-side copy against them.
 *
 * Note the framework ships its own default for the data head —
 * `DATA_SERVER_PORT_COMMAND` (`'hydranium/data-server/port'`) in
 * `@hydranium/protocol`. This example deliberately overrides it with a
 * project-keyed id, which means a host that binds
 * `DataServerConnectionHandler` with default options polls a command this
 * server never publishes.
 */

/** LSP request the host queries to discover the data-server socket port. */
export const ORDER_FLOW_DATA_SERVER_PORT_COMMAND = 'order-flow/data-server/port';

/** LSP request the host queries to discover the GLSP socket port. */
export const ORDER_FLOW_GLSP_PORT_COMMAND = 'order-flow/glsp/port';
