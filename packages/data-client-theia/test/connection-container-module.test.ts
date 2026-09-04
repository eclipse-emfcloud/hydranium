/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ConnectionHandler } from '@theia/core';
import { ConnectionContainerModule } from '@theia/core/lib/node/messaging/connection-container-module';
import { Container, type ContainerModule, injectable, type interfaces } from '@theia/core/shared/inversify';
import { createDataServerConnectionContainerModule } from '../src/node/connection-container-module';

@injectable()
class HandlerOne implements ConnectionHandler {
   readonly path: string = '/services/one';
   onConnection(): void {}
}

@injectable()
class HandlerTwo implements ConnectionHandler {
   readonly path: string = '/services/two';
   onConnection(): void {}
}

/**
 * Resolve the frontend-scoped module the factory produced and apply it to a
 * child container, the way Theia's messaging layer does per frontend
 * connection. The outer module only carries the inner one as a constant, so
 * asserting on the outer bindings alone would prove nothing about what a
 * frontend actually gets.
 */
function frontendScopedContainer(...handlers: interfaces.Newable<ConnectionHandler>[]): Container {
   const outer = new Container();
   outer.load(createDataServerConnectionContainerModule(...handlers));
   const child = new Container();
   for (const module of outer.getAll<ContainerModule>(ConnectionContainerModule)) {
      child.load(module);
   }
   return child;
}

describe('createDataServerConnectionContainerModule', () => {
   it('binds one handler as itself and as a ConnectionHandler', () => {
      const container = frontendScopedContainer(HandlerOne);

      expect(container.getAll(ConnectionHandler)).toHaveLength(1);
      expect(container.get(HandlerOne)).toBeInstanceOf(HandlerOne);
   });

   it('binds EVERY handler when several are passed', () => {
      // The case an adopter reaches as soon as a second frontend abstraction
      // talks to the same head: Theia refuses a second channel on a path
      // already open, so each frontend needs its own path and therefore its own
      // forwarder. A factory that kept only one would leave the other path
      // unserved — and an unserved path does not error, it never answers, so the
      // consumer hangs.
      const container = frontendScopedContainer(HandlerOne, HandlerTwo);

      const paths = container
         .getAll<ConnectionHandler>(ConnectionHandler)
         .map(handler => handler.path)
         .sort();
      expect(paths).toEqual(['/services/one', '/services/two']);
   });

   it('resolves the same singleton by class and through ConnectionHandler', () => {
      // Why `toDynamicValue` rather than `to(handlerClass)`: an adopter injects
      // its handler by its own class for its own reasons, and two instances of a
      // socket forwarder would mean two forwarders racing one path.
      const container = frontendScopedContainer(HandlerOne, HandlerTwo);

      const registered = container.getAll(ConnectionHandler);
      expect(registered).toContain(container.get(HandlerOne));
      expect(registered).toContain(container.get(HandlerTwo));
   });
});
