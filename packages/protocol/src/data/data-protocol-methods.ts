/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { TransferElement } from '../transfer-element';
import type {
   DataClientProtocol,
   DataServerProtocol,
   DocumentClientProtocol,
   DocumentServerProtocol,
   ProjectClientProtocol,
   ProjectServerProtocol,
   ReferenceServerProtocol
} from './data-server-protocol';

/** Request-method names on {@link DocumentServerProtocol}. */
export const DOCUMENT_SERVER_PROTOCOL_METHODS = [
   'openModelDocument',
   'closeModelDocument',
   'getModelDocument',
   'updateModelDocument',
   'saveModelDocument',
   'watchModelDocument',
   'unwatchModelDocument',
   'waitForReady'
] as const satisfies ReadonlyArray<keyof DocumentServerProtocol<TransferElement> & string>;

/** Request-method names on {@link ProjectServerProtocol}. */
export const PROJECT_SERVER_PROTOCOL_METHODS = ['getProjects', 'getProjectForUri'] as const satisfies ReadonlyArray<
   keyof ProjectServerProtocol & string
>;

/**
 * Request-method names on the composed {@link DataServerProtocol} — the
 * document fragment followed by the project fragment. The `as const satisfies`
 * constraint makes the array typed against the interface — stale names (typos,
 * renamed methods) fail to typecheck.
 */
export const DATA_SERVER_PROTOCOL_METHODS = [
   ...DOCUMENT_SERVER_PROTOCOL_METHODS,
   ...PROJECT_SERVER_PROTOCOL_METHODS
] as const satisfies ReadonlyArray<keyof DataServerProtocol<TransferElement> & string>;

/**
 * Request-method names on {@link ReferenceServerProtocol}. NOT part of
 * {@link DATA_SERVER_PROTOCOL_METHODS} — adopters that compose the reference
 * fragment register these alongside (e.g. via a `DataServer` subclass's
 * `additionalMethods`).
 */
export const REFERENCE_SERVER_PROTOCOL_METHODS = [
   'findReferenceCandidates',
   'resolveReference',
   'findNextName'
] as const satisfies ReadonlyArray<keyof ReferenceServerProtocol<TransferElement> & string>;

/** Notification-method names on {@link DocumentClientProtocol}. */
export const DOCUMENT_CLIENT_PROTOCOL_METHODS = [
   'onDocumentUpdated',
   'onDocumentSaved',
   'onDocumentDeleted',
   'onDocumentsBuilt'
] as const satisfies ReadonlyArray<keyof DocumentClientProtocol<TransferElement> & string>;

/** Notification-method names on {@link ProjectClientProtocol}. */
export const PROJECT_CLIENT_PROTOCOL_METHODS = ['onProjectsChanged'] as const satisfies ReadonlyArray<keyof ProjectClientProtocol & string>;

/**
 * Notification-method names on the composed {@link DataClientProtocol}.
 * Passed as the `localMethods` allowlist to `createRpcProxy` (frontend) /
 * `bindRpcMethods` (backend) when binding inbound `on*` notifications — the
 * data head's connection routes `<methodNamespace>onDocumentUpdated` etc. to
 * the bound client target.
 */
export const DATA_CLIENT_PROTOCOL_METHODS = [
   ...DOCUMENT_CLIENT_PROTOCOL_METHODS,
   ...PROJECT_CLIENT_PROTOCOL_METHODS
] as const satisfies ReadonlyArray<keyof DataClientProtocol<TransferElement> & string>;
