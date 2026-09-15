/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { bindChannelLogger, bindConnectionDiagnostics } from '@hydranium/client-theia/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';

/**
 * Records the websocket lifecycle into an Output channel, and warns the user
 * when an outage outlasts the offline buffer.
 *
 * Separate from the preload module that installs the hardening itself, because
 * the two want opposite lifetimes: the rebinds have to happen before Theia
 * builds its connection, while this only observes and needs `MessageService`,
 * which does not exist that early.
 *
 * The channel logger is bound here rather than by the framework because the
 * channel name is the adopter's to choose. The diagram container binds its own
 * through `createGlspClientTheiaModule`; this is the application-scope one, and
 * a child container's binding shadows it for anything resolved there.
 */
export default new ContainerModule(bind => {
   bindChannelLogger(bind, { channelName: 'Order Flow Connection' });
   bindConnectionDiagnostics(bind);
});
