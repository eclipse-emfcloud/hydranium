/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The GLSP part of the page: the Bookstore diagram of the file the editor
// shows, drawn by the client module every host of this project mounts.

import type { WorkerHeads } from '@hydranium/client-browser';
import { glspConnection, type GlspDiagramMount, HydraniumGlspClient, mountGlspDiagram } from '@hydranium/glsp-client';
import { describeError, type Logger } from '@hydranium/protocol';
import { initializeBookstoreDiagramContainer } from '@hydranium/bookstore-client';
import { BOOKSTORE_DIAGRAM_TYPE, BOOKSTORE_LANGUAGE } from '@hydranium/bookstore-protocol';
import type { ShownFile } from './editor.js';
import { appendLog } from './log.js';

/**
 * Show the diagram of the file the editor shows, and of each file it switches
 * to. A file of another language hides the pane.
 */
export async function mountDiagram(connection: WorkerHeads['glsp'], shownFile: ShownFile, logger: Logger): Promise<void> {
   const glspClient = new HydraniumGlspClient({ id: 'diagram', connectionProvider: glspConnection(connection) });
   let mounted: GlspDiagramMount | undefined;
   let mountedUri: string | undefined;
   const show = async (uri: string): Promise<void> => {
      // Switched away while queued: the show queued for the newer file replaces this one.
      // Switched back before the switch away ran: its diagram is still the one shown.
      if (uri !== shownFile.current() || uri === mountedUri) {
         return;
      }
      mounted?.dispose();
      mounted = undefined;
      mountedUri = undefined;
      // A fresh element, since a disposed mount leaves what it drew.
      const element = document.createElement('div');
      element.id = 'diagram';
      (document.getElementById('diagram') as HTMLElement).replaceWith(element);
      const pane = document.getElementById('diagram-pane') as HTMLElement;
      // Shown before the mount, which measures the element it draws into.
      pane.hidden = !BOOKSTORE_LANGUAGE.fileExtensions.some(extension => uri.endsWith(extension));
      if (pane.hidden) {
         return;
      }
      mounted = await mountGlspDiagram({
         mount: element,
         diagramType: BOOKSTORE_DIAGRAM_TYPE,
         sourceUri: uri,
         glspClient,
         initializeDiagramContainer: initializeBookstoreDiagramContainer,
         logger
      });
      if (mounted.loadOutcome.status === 'failed') {
         throw new Error(`the diagram of ${uri} did not load: ${describeError(mounted.loadOutcome.error)}`);
      }
      mountedUri = uri;
   };

   // One mount at a time, so one still loading is not disposed half built, and a
   // failed one does not stop the next.
   let switching: Promise<void> = Promise.resolve();
   const follow = (uri: string): Promise<void> => {
      const shown = switching.then(() => show(uri));
      switching = shown.catch(() => undefined);
      return shown;
   };
   // Before the first mount, which the editor does not wait for.
   shownFile.onDidChange(uri => {
      follow(uri).catch((error: unknown) => appendLog(describeError(error)));
   });
   await follow(shownFile.current());
}
