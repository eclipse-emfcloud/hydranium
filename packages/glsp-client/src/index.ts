/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The host-neutral GLSP client classes and the binder that mounts them. This
// root is browser-bound, not neutral: it loads `@eclipse-glsp/client`, whose
// graph imports stylesheets, so it needs a bundler with a CSS loader. It is
// free of Node and of any host platform, which is the claim `check:neutral`
// gates.
export * from './action-dispatcher';
export * from './diagram-load-failed';
export * from './diagram-loader';
export * from './glsp-client';
export * from './glsp-client-module';
export * from './hidden-bounds-updater';
export * from './sprotty-logger-adapter';
export * from './status-overlay';
export * from './types';
