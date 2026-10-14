/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type GLSPDiagramLanguage } from '@eclipse-glsp/theia-integration/lib/common';
import { PROCESS_DIAGRAM_TYPE, PROCESS_LANGUAGE } from '@hydranium/example-order-flow-protocol';

/**
 * Theia-side identifiers for the order-flow shell.
 *
 * Everything that has an authoritative definition elsewhere is **imported**
 * rather than restated — `PROCESS_DIAGRAM_TYPE` and the file extensions come
 * from the protocol package. What is spelled out below is either local to this
 * shell or lives in a package a Theia extension must not depend on; where a
 * string has to match another package's, this package's unit tests assert it
 * against that source.
 */

/** Theia contribution id for the `.process` diagram. Local to this shell. */
export const ORDER_FLOW_DIAGRAM_LANGUAGE_ID = 'order-flow-contribution';

/** Human-readable diagram name, for editor tabs and command labels. Local to this shell. */
export const PROCESS_DIAGRAM_LABEL = 'Order Flow Process Diagram';

/**
 * The **host** command ids the order-flow VS Code extension registers, which
 * are what a Theia backend connection handler executes through `CommandService`.
 *
 * Not to be confused with the LSP request ids
 * (`ORDER_FLOW_DATA_SERVER_PORT_COMMAND` / `ORDER_FLOW_GLSP_PORT_COMMAND` in
 * `order-flow-protocol`): the extension asks the *server* under those, and
 * republishes the answer under these. A Theia handler that queries an LSP id
 * finds no command at all.
 *
 * They are duplicated here by construction: the extension declares them in a
 * VS Code extension package, whose module graph reaches `vscode` and
 * `vscode-languageclient`, so a Theia extension cannot import them without
 * dragging that into its own build. Getting one wrong is silent —
 * `AbstractSocketForwardingConnectionHandler` polls with `findPortAttempts = -1`, so a
 * wrong id retries forever instead of failing — which is why a unit test in this
 * package pins the naming rule and checks these ids against the LSP request
 * ids.
 */
export const ORDER_FLOW_HOST_PORT_COMMANDS = {
   dataServer: 'order-flow.port.dataServer',
   glsp: 'order-flow.port.glsp'
} as const;

/**
 * Theia Output channel the order-flow LSP client writes to.
 *
 * Must match the `name` the VS Code extension passes to `new LanguageClient`
 * (`'Order Flow'`), because that is the channel `vscode-languageclient` creates
 * and the one `plugin-ext` surfaces to Theia.
 */
export const ORDER_FLOW_OUTPUT_CHANNEL = 'Order Flow';

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
   fileExtensions: [...PROCESS_LANGUAGE.fileExtensions]
};
