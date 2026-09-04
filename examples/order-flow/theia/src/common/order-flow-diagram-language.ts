/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type GLSPDiagramLanguage } from '@eclipse-glsp/theia-integration/lib/common';
// The MODULE, not the client barrel: the barrel re-exports the diagram
// definition, whose `@eclipse-glsp/client` graph reaches CSS imports that a
// plain `tsc` build has no loader for. The types module itself only imports
// `@eclipse-glsp/protocol`, so it is safe to reach directly — the same rule the
// VS Code webview bootstrap follows.
import {
   PROCESS_DIAGRAM_FILE_EXTENSIONS,
   PROCESS_DIAGRAM_LABEL,
   PROCESS_DIAGRAM_TYPE
} from '@hydranium/example-order-flow-client/lib/diagram/order-flow-process-diagram-types';

/**
 * Theia-side identifiers for the order-flow shell.
 *
 * Everything that has an authoritative definition elsewhere is **imported**
 * rather than restated — `PROCESS_DIAGRAM_TYPE` and the file extensions come
 * from the client package, which is in this package's dependency graph. What is
 * spelled out below is either local to this shell or lives in a package a Theia
 * extension must not depend on; where a string has to match another package's,
 * this package's unit tests assert it against that source.
 */

/** Theia contribution id for the `.process` diagram. Local to this shell. */
export const ORDER_FLOW_DIAGRAM_LANGUAGE_ID = 'order-flow-contribution';

/**
 * The **host** command ids the order-flow VS Code extension registers, which
 * are what a Theia backend connection handler executes through `CommandService`.
 *
 * Not to be confused with the LSP request ids
 * (`ORDER_FLOW_DATA_SERVER_PORT_COMMAND` / `ORDER_FLOW_GLSP_PORT_COMMAND` in
 * `order-flow-server`): the extension asks the *server* under those, and
 * republishes the answer under these. A Theia handler that queries an LSP id
 * finds no command at all.
 *
 * They are duplicated here by construction: the extension declares them in a
 * VS Code extension package, whose module graph reaches `vscode` and
 * `vscode-languageclient`, so a Theia extension cannot import them without
 * dragging that into its own build. Getting one wrong is silent —
 * `AbstractSocketForwardingConnectionHandler` polls with `findPortAttempts = -1`, so a
 * wrong id retries forever instead of failing — which is why a unit test in this
 * package pins the naming rule and checks these ids against the server's LSP
 * request ids, which it can import.
 */
export const ORDER_FLOW_HOST_PORT_COMMANDS = {
   dataServer: 'order-flow.port.dataServer',
   glsp: 'order-flow.port.glsp'
} as const;

/**
 * Theia service path the memory-diagnostics frontend opens its channel to.
 *
 * A SECOND path to the one data server, and it is required rather than tidy:
 * Theia keys a frontend channel by its service path and refuses a second
 * channel on a path already open. This extension has two independent consumers
 * of the data head — the properties panel's host-neutral `DataPort` on the
 * framework default `DATA_SERVER_PATH`, and `OrderFlowDiagnosticsDataService`,
 * a Theia `AbstractDataServiceFrontend` that owns its own channel — so sharing
 * one path breaks whichever opens second.
 *
 * The failure is worth knowing because it does not look like a collision: the
 * throw escapes the `openChannelConnection` the other consumer was awaiting, so
 * its promise is left unsettled rather than rejected. The properties panel sat
 * on `Loading…` forever with a clean server log and one page error nobody was
 * reading. Both handlers still forward to the SAME process — the shared
 * `ORDER_FLOW_HOST_PORT_COMMANDS.dataServer` is what names it.
 */
export const ORDER_FLOW_DATA_DIAGNOSTICS_PATH = '/order-flow/data-server/diagnostics';

/**
 * Theia Output channel the order-flow LSP client writes to.
 *
 * Must match the `name` the VS Code extension passes to `new LanguageClient`
 * (`'Order Flow'`), because that is the channel `vscode-languageclient` creates
 * and the one `plugin-ext` surfaces to Theia. The GLSP server's own logs land
 * here too — they route through `GlspClientLogger` onto the LSP connection —
 * which is what lets the client contribution tail this one channel for
 * {@link ORDER_FLOW_GLSP_READY_MARKER}.
 */
export const ORDER_FLOW_OUTPUT_CHANNEL = 'Order Flow';

/**
 * Server-printed marker the client contribution tails before connecting.
 *
 * The string is `@eclipse-glsp/server`'s own, logged by its JSON-RPC launcher
 * when a client CONNECTS to the GLSP socket — not when the socket starts
 * listening, which is the earlier and less useful moment. It reaches this
 * channel because `startGlspServer` binds the container's logger onto the
 * adopter's `createLogger`, which routes over the LSP connection. Changing it
 * means changing what the launcher prints, so it is taken as given.
 */
export const ORDER_FLOW_GLSP_READY_MARKER = 'Starting GLSP server connection';

/**
 * Preference driving the framework log threshold, applied once at startup.
 *
 * **Declared by the sideloaded VS Code extension, not here.**
 * `bindLogLevelPreference` only READS the preference; the schema that makes it
 * settable comes from that extension's `contributes.configuration`, which
 * `plugin-ext` registers into Theia. Theia validates `PreferenceService.get`
 * against the registered schema, so without that declaration the value is not
 * merely invisible in Settings — it is dropped as unknown and the threshold
 * never changes. Every extension that can host this server therefore declares
 * the same property name, and the id below must match it.
 */
export const ORDER_FLOW_LOG_LEVEL_PREFERENCE = 'order-flow.log.level';

export const OrderFlowProcessDiagramLanguage: GLSPDiagramLanguage = {
   contributionId: ORDER_FLOW_DIAGRAM_LANGUAGE_ID,
   label: PROCESS_DIAGRAM_LABEL,
   diagramType: PROCESS_DIAGRAM_TYPE,
   fileExtensions: [...PROCESS_DIAGRAM_FILE_EXTENSIONS]
};
