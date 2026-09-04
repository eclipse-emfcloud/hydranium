/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ConnectionHandler } from '@theia/core';
import { ConnectionContainerModule } from '@theia/core/lib/node/messaging/connection-container-module';
import { ContainerModule, type interfaces } from '@theia/core/shared/inversify';

/**
 * Creates the frontend-scoped Theia backend module that registers a GLSP
 * `ConnectionHandler` per browser-frontend connection. Returns a ready-to-
 * export `ContainerModule` so adopters can `export default createGlspConnectionContainerModule(MyHandler)`
 * from their backend-module entry point.
 *
 * The wrapping `ContainerModule + ConnectionContainerModule.create` pattern
 * mirrors the boilerplate every Theia GLSP adopter writes by hand; lifted so
 * adopters declare only the handler class.
 */
export function createGlspConnectionContainerModule(handlerClass: interfaces.Newable<ConnectionHandler>): ContainerModule {
   const frontendScopedConnectionModule = ConnectionContainerModule.create(({ bind }) => {
      bind(handlerClass).toSelf().inSingletonScope();
      bind(ConnectionHandler)
         .toDynamicValue(context => context.container.get(handlerClass))
         .inSingletonScope();
   });
   return new ContainerModule(bind => {
      bind(ConnectionContainerModule).toConstantValue(frontendScopedConnectionModule);
   });
}
