// The __GRAMMAR__ diagram webview: GLSP's handshake with the extension host,
// over the diagram the client package defines. Never import this from the
// extension: its graph reaches stylesheets, which Node cannot load.

import type { ContainerConfiguration } from '@eclipse-glsp/client';
import { HydraniumGlspStarter } from '@hydranium/glsp-client-vscode/browser';
import { Container } from 'inversify';
import { initialize__GRAMMAR__DiagramContainer } from '__CLIENT_PACKAGE__';
// Last, so its rules follow GLSP's stylesheet in the bundle.
import './diagram.css';

class __GRAMMAR__DiagramStarter extends HydraniumGlspStarter {
   createContainer(...containerConfiguration: ContainerConfiguration): Container {
      return initialize__GRAMMAR__DiagramContainer(new Container(), ...containerConfiguration);
   }
}

new __GRAMMAR__DiagramStarter();
