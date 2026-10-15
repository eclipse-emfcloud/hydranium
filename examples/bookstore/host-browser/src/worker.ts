/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The worker hosting the heads: every head over one store, in the browser and
// with no backend. The page reaches each head over a `MessagePort` of its own.

// First, before any class carrying a decorator loads: GLSP reads the metadata
// its decorators emit as each class is defined.
import 'reflect-metadata';
import { ServerModule } from '@eclipse-glsp/server/browser.js';
import { persistentFileSystem } from '@hydranium/core';
import { hostHeadsInWorker, IndexedDbFileSystemStore, startLanguageServerInWorker } from '@hydranium/core/browser';
import { DataServer } from '@hydranium/data-server';
import { startDataServerInWorker } from '@hydranium/data-server/browser';
import { GlspClientLogger, HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { startGlspServerInWorker } from '@hydranium/glsp-server/browser';
import type { BookstoreModel } from '@hydranium/bookstore-protocol';
import { BookstoreDiagramModule, createBookstoreServices } from '@hydranium/bookstore-server';
import { WORKSPACE_ROOT_URI } from './workspace.js';

/** The files of `../workspace`, read by `esbuild.mjs` and keyed by their path below the root. */
declare const __WORKSPACE_SEED__: Record<string, string>;
/** This project's directory, hashed by `esbuild.mjs`, so that no other project on the origin opens its store. */
declare const __DIRECTORY_KEY__: string;

// A saved file is kept in IndexedDB and laid over the seed on the next load;
// the heads start once the stored files are restored.
const store = new IndexedDbFileSystemStore(`bookstore-workspace-${__DIRECTORY_KEY__}`);

hostHeadsInWorker(
   persistentFileSystem({ store, seed: __WORKSPACE_SEED__, rootUri: WORKSPACE_ROOT_URI }),
   (ports, fileSystem) => {
      // The LSP head composes the services, as the Node entry does around stdio.
      const shared = startLanguageServerInWorker(ports.lsp, connection => createBookstoreServices({ connection, ...fileSystem }).shared);
      // The data head serves from the LSP head's store, on its own port.
      startDataServerInWorker(ports.data, shared, connection => new DataServer<BookstoreModel>(connection, shared));
      const glsp = startGlspServerInWorker({
         context: ports.glsp,
         createLogger: caller => new GlspClientLogger(shared, { component: caller }),
         serverModule: new ServerModule().configureDiagramModule(new BookstoreDiagramModule()),
         appModules: [new HydraniumGlspAppModule({ shared })]
      });
      // The GLSP head reports a failed start through `started`, which the
      // ready message waits for.
      return { shared, started: [glsp.started] };
   },
   // The ready message then carries the workspace files the page opens.
   { rootUri: WORKSPACE_ROOT_URI }
);
