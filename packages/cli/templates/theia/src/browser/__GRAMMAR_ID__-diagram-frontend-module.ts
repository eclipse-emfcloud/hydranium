// The __GRAMMAR__ diagram in Theia: the client package's diagram, opened from
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
import { initialize__GRAMMAR__DiagramContainer } from '__CLIENT_PACKAGE__';
import { __GRAMMAR_ID_CONST___DIAGRAM_TYPE, __GRAMMAR_ID_CONST___LANGUAGE } from '__PROTOCOL_PACKAGE__';
import { __CONFIG_ROOT_CONST___GLSP_CONTRIBUTION_ID } from '../common/__PROJECT_ID__-glsp-contribution.js';
import '../../style/diagram.css';

export const __GRAMMAR__DiagramLanguage: GLSPDiagramLanguage = {
   contributionId: __CONFIG_ROOT_CONST___GLSP_CONTRIBUTION_ID,
   label: '__GRAMMAR__ Diagram',
   diagramType: __GRAMMAR_ID_CONST___DIAGRAM_TYPE,
   fileExtensions: [...__GRAMMAR_ID_CONST___LANGUAGE.fileExtensions]
};

// Theia's host bindings, logging to the language client's Output channel. Passed
// after GLSP's Theia modules, whose bindings it replaces; a rebind made earlier
// is overwritten without an error.
const theiaModule = new ContainerModule((bind, unbind, isBound, rebind) => {
   createGlspClientTheiaModule({ bind, unbind, isBound, rebind }, { channelLogger: { channelName: '__NAME__' } });
});

@injectable()
export class __GRAMMAR__DiagramConfiguration extends AbstractHydraniumGlspDiagramConfiguration {
   diagramType = __GRAMMAR_ID_CONST___DIAGRAM_TYPE;
   // The LSP head already reports these problems.
   protected override propagateMarkersToProblemsView = false;

   configureContainer(container: Container, ...containerConfiguration: ContainerConfiguration): Container {
      return initialize__GRAMMAR__DiagramContainer(container, ...containerConfiguration, theiaModule);
   }
}

@injectable()
export class __GRAMMAR__DiagramManager extends AbstractHydraniumGlspDiagramManager {
   protected readonly diagramLanguage = __GRAMMAR__DiagramLanguage;
   protected readonly managerLabel = '__GRAMMAR__ Diagram Editor';

   override get id(): string {
      return '__GRAMMAR_ID__-diagram-manager';
   }
}

export class __GRAMMAR__DiagramModule extends AbstractHydraniumGlspTheiaFrontendModule {
   readonly diagramLanguage = __GRAMMAR__DiagramLanguage;
   protected readonly diagramConfiguration = __GRAMMAR__DiagramConfiguration;
   protected readonly diagramManager = __GRAMMAR__DiagramManager;

   protected override bindClientContribution(): SkipClientContribution {
      return SkipClientContribution;
   }
}

export default new __GRAMMAR__DiagramModule();
