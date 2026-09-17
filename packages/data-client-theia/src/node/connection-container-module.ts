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
 * Creates the frontend-scoped Theia backend module that registers a
 * data-server {@link ConnectionHandler} (a `DataServerConnectionHandler`
 * subclass) per browser-frontend connection. Returns a ready-to-export
 * `ContainerModule` so adopters can
 * `export default createDataServerConnectionContainerModule(MyHandler)` from
 * their backend-module entry point.
 *
 * Sibling of `@hydranium/glsp-client-theia`'s
 * `createGlspConnectionContainerModule` — the `ContainerModule +
 * ConnectionContainerModule.create` boilerplate every frontend-scoped Theia
 * connection adopter writes by hand, lifted so adopters declare only the
 * handler class.
 *
 * **More than one handler is the normal case, not an exotic one.** Theia keys a
 * frontend channel by its service path and refuses a second channel on a path
 * already open, so every frontend abstraction reaching the data head on its own
 * channel needs its own path and therefore its own handler. They still forward
 * to the SAME data server: the path distinguishes the channel, the shared
 * `portCommand` names the one process behind it. Several participants over ONE
 * channel need no second handler — that is what `DataConnection`'s sessions are
 * for, and it is the cheaper arrangement.
 */
export function createDataServerConnectionContainerModule(...handlerClasses: interfaces.Newable<ConnectionHandler>[]): ContainerModule {
   const frontendScopedConnectionModule = ConnectionContainerModule.create(({ bind }) => {
      for (const handlerClass of handlerClasses) {
         bind(handlerClass).toSelf().inSingletonScope();
         // `toDynamicValue` over `to(handlerClass)`: `ConnectionHandler` is
         // multi-bound here, and resolving through the container keeps each
         // entry the SAME singleton the adopter can inject by its own class.
         bind(ConnectionHandler)
            .toDynamicValue(context => context.container.get(handlerClass))
            .inSingletonScope();
      }
   });
   return new ContainerModule(bind => {
      bind(ConnectionContainerModule).toConstantValue(frontendScopedConnectionModule);
   });
}
