/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { GLSPServer } from '@eclipse-glsp/server';
import { ContainerModule } from 'inversify';
import { HydraniumGlspServer } from './hydranium-glsp-server.js';

/**
 * The framework bindings layered on top of the adopter's `ServerModule`, in the
 * SERVER container — one per connected application, a child of the app
 * container every bringup composes.
 *
 * **The tier matters, and the app container cannot stand in for it.** GLSP's
 * launcher creates the server container as a child and loads the adopter's
 * `ServerModule` into it, so a `GLSPServer` binding made further up is shadowed
 * rather than consulted, and inversify refuses to rebind a parent's binding
 * from a child at all. The framework's app-tier overrides therefore cannot
 * reach this symbol.
 *
 * **Load this AFTER the adopter's `ServerModule`, never beside it.** Both bind
 * `GLSPServer`, so a plain second binding resolves to an ambiguous-match error
 * rather than to either one; `rebind` needs the first binding to already be
 * present.
 *
 * Keeping this out of the adopter's hands is the point: an adopter passes their
 * own `ServerModule` in, so anything they must add themselves is a fix the
 * adopters who most need it will not have.
 *
 * **It also decides what GLSP's own log lines are tagged with.** GLSP resolves
 * a logger per injecting class and labels it with the bound implementation's
 * name, so every line upstream's server logs carries
 * {@link HydraniumGlspServer} rather than `DefaultGLSPServer`. Anything keyed
 * on that label — a log filter, an assertion — reads the class bound here, and
 * a further adopter subclass moves it again.
 */
export function createGlspServerOverrides(): ContainerModule {
   return new ContainerModule((_bind, _unbind, _isBound, rebind) => {
      rebind(GLSPServer).to(HydraniumGlspServer).inSingletonScope();
   });
}
