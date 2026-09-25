/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { bindChannelLogger, bindConnectionDiagnostics, EditorDiskSync, HydraniumFileService } from '@hydranium/client-theia/lib/browser';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { FileService } from '@theia/filesystem/lib/browser/file-service';

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
 *
 * It also binds `EditorDiskSync`, which keeps an editor from corrupting a file
 * the data or GLSP head saved while the editor showed the same text unsaved.
 * It belongs to no single head, which is why it sits in this module. Beside it,
 * `HydraniumFileService` replaces Theia's file service, so an editor save that
 * `EditorDiskSync` cannot catch writes the whole text instead of applying its
 * edits to a file that already holds them.
 */
export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
   bindChannelLogger(bind, { channelName: 'Order Flow Connection' });
   bindConnectionDiagnostics(bind);
   bind(EditorDiskSync).toSelf().inSingletonScope();
   bind(FrontendApplicationContribution).toService(EditorDiskSync);
   rebind(FileService).to(HydraniumFileService).inSingletonScope();
});
