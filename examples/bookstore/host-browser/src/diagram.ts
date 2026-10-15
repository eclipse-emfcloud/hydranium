/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The GLSP part of the page: the Bookstore diagram of the file the page
// shows, drawn by the client module every host of this project mounts.

import type { WorkerHeads } from '@hydranium/client-browser';
import { glspConnection, type GlspDiagramMount, HydraniumGlspClient, mountGlspDiagram } from '@hydranium/glsp-client';
import { describeError, type Logger } from '@hydranium/protocol';
import { initializeBookstoreDiagramContainer } from '@hydranium/bookstore-client';
import { BOOKSTORE_DIAGRAM_TYPE, BOOKSTORE_LANGUAGE } from '@hydranium/bookstore-protocol';
import { appendLog } from './log.js';
import type { ShownFile } from './shown-file.js';

/**
 * Show the diagram of the file the page shows, and of each file it switches
 * to, and hand back what reads the mount shown now, if it loaded. A file of
 * another language hides the pane. `beforeLeave` runs on the shown mount before a switch
 * disposes it; when it throws, that mount stays shown and the page switches
 * back to its file.
 */
export async function mountDiagram(
   connection: WorkerHeads['glsp'],
   shownFile: ShownFile,
   logger: Logger,
   beforeLeave?: (mount: GlspDiagramMount) => Promise<void>
): Promise<() => GlspDiagramMount | undefined> {
   const glspClient = new HydraniumGlspClient({ id: 'diagram', connectionProvider: glspConnection(connection) });
   let mounted: GlspDiagramMount | undefined;
   let mountedUri: string | undefined;
   const show = async (uri: string): Promise<void> => {
      // Switched away while queued: the show queued for the newer file replaces this one.
      // Switched back before the switch away ran: its diagram is still the one shown.
      if (uri !== shownFile.current() || uri === mountedUri) {
         return;
      }
      // Only a mount that loaded: one that failed has no edits to lose, and its
      // dispatcher may refuse every save, which would keep it shown for good.
      if (mounted !== undefined && mountedUri !== undefined && beforeLeave !== undefined) {
         try {
            await beforeLeave(mounted);
         } catch (error: unknown) {
            // The diagram stays on its file, so the switch goes back to it.
            shownFile.show(mountedUri);
            throw error;
         }
         // Switched again while it ran: the show queued for that file takes over.
         if (uri !== shownFile.current()) {
            return;
         }
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
   // Before the first mount, since the page can switch while it loads.
   shownFile.onDidChange(uri => {
      follow(uri).catch((error: unknown) => appendLog(describeError(error)));
   });
   // A first file that fails to load is logged as a later switch's is, so the
   // page still arms what follows and the switch can reach a file that loads.
   await follow(shownFile.current()).catch((error: unknown) => appendLog(describeError(error)));
   // Only a mount that loaded: one that failed has nothing to save.
   return () => (mountedUri === undefined ? undefined : mounted);
}
