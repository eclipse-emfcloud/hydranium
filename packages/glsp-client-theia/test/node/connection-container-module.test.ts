/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type Channel, ConnectionHandler } from '@theia/core';
import { ConnectionContainerModule } from '@theia/core/lib/node/messaging/connection-container-module';
import { Container, type ContainerModule, injectable } from '@theia/core/shared/inversify';
import { createGlspConnectionContainerModule } from '../../src/node/connection-container-module';

@injectable()
class FakeHandler implements ConnectionHandler {
   readonly path = '/services/fake';
   onConnection(_connection: Channel): void {
      // no-op
   }
}

describe('createGlspConnectionContainerModule', () => {
   it('returns a ContainerModule that registers a ConnectionContainerModule', () => {
      const module = createGlspConnectionContainerModule(FakeHandler);
      const container = new Container();
      container.load(module);
      const registered = container.getAll<ContainerModule>(ConnectionContainerModule);
      expect(registered).toHaveLength(1);
   });

   it('frontend-scoped child container resolves the handler and binds it as ConnectionHandler', () => {
      const module = createGlspConnectionContainerModule(FakeHandler);
      const parent = new Container();
      parent.load(module);
      // The frontend-scoped sub-module is captured as a ConstantValue on the parent;
      // exercise the captured callback against a fresh child container so the bindings
      // become observable here without going through Theia's full RPC plumbing.
      const child = new Container();
      const submodule = parent.get<ContainerModule>(ConnectionContainerModule);
      // ConnectionContainerModule wraps a ContainerModule; load it on the child.
      child.load(submodule);
      const handler = child.get<FakeHandler>(FakeHandler);
      expect(handler).toBeInstanceOf(FakeHandler);
      const asConnHandler = child.get<ConnectionHandler>(ConnectionHandler);
      expect(asConnHandler).toBe(handler);
   });
});
