/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The Bookstore diagram webview: GLSP's handshake with the extension host,
// over the diagram the client package defines. Never import this from the
// extension: its graph reaches stylesheets, which Node cannot load.

import type { ContainerConfiguration } from '@eclipse-glsp/client';
import { HydraniumGlspStarter } from '@hydranium/glsp-client-vscode/browser';
import { Container } from 'inversify';
import { initializeBookstoreDiagramContainer } from '@hydranium/bookstore-client';
// Last, so its rules follow GLSP's stylesheet in the bundle.
import './diagram.css';

class BookstoreDiagramStarter extends HydraniumGlspStarter {
   createContainer(...containerConfiguration: ContainerConfiguration): Container {
      return initializeBookstoreDiagramContainer(new Container(), ...containerConfiguration);
   }
}

new BookstoreDiagramStarter();
