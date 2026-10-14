/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ContainerConfiguration } from '@eclipse-glsp/client';
import { GLSPStarter } from '@eclipse-glsp/vscode-integration-webview';
import { createGlspClientModule, type GlspClientModuleOptions } from '@hydranium/glsp-client';
import { ContainerModule } from 'inversify';

/**
 * The diagram webview's starter: GLSP's handshake with the extension host,
 * with the framework's client module among the modules the container is built
 * from.
 *
 * The module follows the host's own, since it replaces tokens they bind, and
 * comes before whatever `createContainer` appends: GLSP's model and view
 * registries give an element type to the module that registers it last, so a
 * subclass appends its diagram definition last.
 */
export abstract class HydraniumGlspStarter extends GLSPStarter {
   protected override getContainerConfiguration(): ContainerConfiguration {
      return [
         ...super.getContainerConfiguration(),
         new ContainerModule((bind, unbind, isBound, rebind) =>
            createGlspClientModule({ bind, unbind, isBound, rebind }, this.glspClientModuleOptions())
         )
      ];
   }

   /** Options for the framework's client module. Without a logger it logs to the webview's console, the only sink a webview has. */
   protected glspClientModuleOptions(): GlspClientModuleOptions {
      return {};
   }
}
