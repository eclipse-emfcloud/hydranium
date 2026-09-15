/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { bindConnectionResilience } from '@hydranium/client-theia/lib/node';
import { BackendApplicationConfigProvider } from '@theia/core/lib/node/backend-application-config-provider';
import { ContainerModule } from '@theia/core/shared/inversify';

/**
 * Installs the framework's reconnect hardening on the server side: only the
 * socket a session is currently using may act on a disconnect, and buffered
 * messages go out one per send.
 *
 * Both halves are needed. The server fix is what stops a socket the browser
 * walked away from tearing the session off the socket that replaced it, and the
 * browser cannot compensate for that — it sees a connected socket and never
 * retries. The message framing matters on both sides because each buffers its
 * own half of the conversation.
 *
 * Nothing here depends on this app: an adopter's backend module is these two
 * lines, and the size option is the only thing worth varying. It is read from
 * `theia.backend.config` so both sides of the socket agree on how much they will
 * hold while the other is away.
 */
export default new ContainerModule((bind, _unbind, isBound, rebind) => {
   const bufferBytes = BackendApplicationConfigProvider.get()['connectionBufferBytes'];
   bindConnectionResilience(bind, isBound, rebind, { bufferBytes: typeof bufferBytes === 'number' ? bufferBytes : undefined });
});
