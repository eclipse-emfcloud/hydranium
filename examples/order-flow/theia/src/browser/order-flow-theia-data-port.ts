/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ChannelDataPort } from '@hydranium/data-client-theia/lib/browser';
import { DATA_SERVER_PATH } from '@hydranium/protocol';
import { injectable } from '@theia/core/shared/inversify';

/**
 * The Theia end of the data head's transport.
 *
 * One line of adopter code, and that is the demonstration: the channel, the
 * workspace gate, the reconnect signal and the error sink all ship in
 * `ChannelDataPort`, and everything above it — the connection, its sessions,
 * the properties model, the form — is shared verbatim with the VS Code shell.
 */
@injectable()
export class OrderFlowTheiaDataPort extends ChannelDataPort {
   protected readonly servicePath = DATA_SERVER_PATH;
}
