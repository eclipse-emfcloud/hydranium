/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Public surface of the host-agnostic order-flow client.
 *
 * A host shell composes the diagram definition into its own container and
 * supplies the transport; nothing here imports a host package, which is what
 * lets one diagram implementation be mounted by Theia, VS Code and a browser
 * app. The contract with `order-flow-server` is the diagram type and the
 * element type ids in `./diagram/order-flow-process-diagram-types`.
 *
 * The two heads reach their transport differently, and the asymmetry is the
 * reason only one of them needs a port. The **diagram** needs none: GLSP's
 * `IDiagramOptions.glspClientProvider` is a required field that both hosts
 * already supply through `containerConfiguration`, so the diagram module is
 * handed a `GLSPClient` and binds nothing transport-related. The **data head**
 * does, because in a VS Code webview there is no way to reach the extension
 * host's connection.
 *
 * That port is framework surface, not example surface: `DataPort`,
 * `DataSession`, `DataEvents` and `createPostMessageTransport` are host-neutral
 * and grammar-free, and this example imports them from `@hydranium/protocol`.
 * What stays is what the framework should not carry: the properties model, which
 * chooses which fields are editable; the properties FORM, which is plain DOM and
 * host-free so both shells mount the same class rather than each growing its
 * own; and the messenger channel, the VS Code adapter this example supplies
 * because the framework ships Theia client packages and no VS Code equivalents.
 */

export * from './data/order-flow-messenger-channel';
export * from './data/order-flow-properties-model';
export * from './diagram/order-flow-process-diagram-module';
export * from './diagram/order-flow-process-diagram-types';
export * from './properties/properties-form';
export * from './properties/properties-messages';
