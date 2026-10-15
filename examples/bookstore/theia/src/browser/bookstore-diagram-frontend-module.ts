/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The Bookstore diagram in Theia: the client package's diagram, opened from
// the language's files by a diagram manager. Its GLSP client is the one the
// extension's frontend module binds for every diagram.

import type { ContainerConfiguration } from '@eclipse-glsp/client';
import type { GLSPDiagramLanguage } from '@eclipse-glsp/theia-integration/lib/common';
import {
   AbstractHydraniumGlspDiagramConfiguration,
   AbstractHydraniumGlspDiagramManager,
   AbstractHydraniumGlspTheiaFrontendModule,
   createGlspClientTheiaModule,
   SkipClientContribution
} from '@hydranium/glsp-client-theia/browser';
import { type Container, ContainerModule, injectable } from '@theia/core/shared/inversify';
import { initializeBookstoreDiagramContainer } from '@hydranium/bookstore-client';
import { BOOKSTORE_DIAGRAM_TYPE, BOOKSTORE_LANGUAGE } from '@hydranium/bookstore-protocol';
import { BOOKSTORE_GLSP_CONTRIBUTION_ID } from '../common/bookstore-glsp-contribution.js';
import '../../style/diagram.css';

export const BookstoreDiagramLanguage: GLSPDiagramLanguage = {
   contributionId: BOOKSTORE_GLSP_CONTRIBUTION_ID,
   label: 'Bookstore Diagram',
   diagramType: BOOKSTORE_DIAGRAM_TYPE,
   fileExtensions: [...BOOKSTORE_LANGUAGE.fileExtensions]
};

// Theia's host bindings, logging to the language client's Output channel. Passed
// after GLSP's Theia modules, whose bindings it replaces; a rebind made earlier
// is overwritten without an error.
const theiaModule = new ContainerModule((bind, unbind, isBound, rebind) => {
   createGlspClientTheiaModule({ bind, unbind, isBound, rebind }, { channelLogger: { channelName: 'Bookstore' } });
});

@injectable()
export class BookstoreDiagramConfiguration extends AbstractHydraniumGlspDiagramConfiguration {
   diagramType = BOOKSTORE_DIAGRAM_TYPE;
   // The LSP head already reports these problems.
   protected override propagateMarkersToProblemsView = false;

   configureContainer(container: Container, ...containerConfiguration: ContainerConfiguration): Container {
      return initializeBookstoreDiagramContainer(container, ...containerConfiguration, theiaModule);
   }
}

@injectable()
export class BookstoreDiagramManager extends AbstractHydraniumGlspDiagramManager {
   protected readonly diagramLanguage = BookstoreDiagramLanguage;
   protected readonly managerLabel = 'Bookstore Diagram Editor';

   override get id(): string {
      return 'bookstore-diagram-manager';
   }
}

export class BookstoreDiagramModule extends AbstractHydraniumGlspTheiaFrontendModule {
   readonly diagramLanguage = BookstoreDiagramLanguage;
   protected readonly diagramConfiguration = BookstoreDiagramConfiguration;
   protected readonly diagramManager = BookstoreDiagramManager;

   protected override bindClientContribution(): SkipClientContribution {
      return SkipClientContribution;
   }
}

export default new BookstoreDiagramModule();
