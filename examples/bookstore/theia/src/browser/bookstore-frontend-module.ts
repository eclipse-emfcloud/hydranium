/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The Bookstore Theia extension's frontend: the connection’s lifecycle in an
// Output channel, a warning when an outage outlasts the offline buffer, editor
// disk sync, the data head’s connection and the Show Model command, and the
// GLSP client the diagrams share.

import { GLSPClientContribution } from '@eclipse-glsp/theia-integration';
import { bindChannelLogger, bindConnectionDiagnostics, bindEditorDiskSync } from '@hydranium/client-theia/browser';
import { bindDataConnection } from '@hydranium/data-client-theia/browser';
import { CommandContribution } from '@theia/core';
import { ContainerModule } from '@theia/core/shared/inversify';
import { BookstoreDataConnection } from './bookstore-data-connection.js';
import { BookstoreDataPort } from './bookstore-data-port.js';
import { BookstoreGlspClientContribution } from './bookstore-glsp-client-contribution.js';
import { BookstoreShowModelCommand } from './bookstore-show-model-command.js';

export default new ContainerModule((bind, _unbind, isBound, rebind) => {
   bindChannelLogger(bind, { channelName: 'Bookstore Connection' });
   bindConnectionDiagnostics(bind);
   // Keeps an editor from writing over a file a head saved while it held the same text unsaved.
   bindEditorDiskSync(bind, isBound, rebind);

   // The data head: one connection, opened when the command first runs.
   bind(BookstoreDataPort).toSelf().inSingletonScope();
   bindDataConnection(bind, isBound, BookstoreDataConnection);
   bind(BookstoreShowModelCommand).toSelf().inSingletonScope();
   bind(CommandContribution).toService(BookstoreShowModelCommand);

   // One GLSP client for every diagram, so each diagram module skips binding its own.
   bind(BookstoreGlspClientContribution).toSelf().inSingletonScope();
   bind(GLSPClientContribution).toService(BookstoreGlspClientContribution);
});
