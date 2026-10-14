/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The GLSP part of the page: the Bookstore diagram of one document, drawn by
// the client module every host of this project mounts.

import type { WorkerHeads } from '@hydranium/client-browser';
import { glspConnection, HydraniumGlspClient, mountGlspDiagram } from '@hydranium/glsp-client';
import { describeError, type Logger } from '@hydranium/protocol';
import { initializeBookstoreDiagramContainer } from '@hydranium/bookstore-client';
import { BOOKSTORE_DIAGRAM_TYPE } from '@hydranium/bookstore-protocol';

/** Show the diagram of `sourceUri` in the page's diagram pane. */
export async function mountDiagram(connection: WorkerHeads['glsp'], sourceUri: string, logger: Logger): Promise<void> {
   // Shown before the mount, which measures the element it draws into.
   (document.getElementById('diagram-pane') as HTMLElement).hidden = false;
   const glspClient = new HydraniumGlspClient({ id: 'diagram', connectionProvider: glspConnection(connection) });
   const { loadOutcome } = await mountGlspDiagram({
      mount: document.getElementById('diagram') as HTMLElement,
      diagramType: BOOKSTORE_DIAGRAM_TYPE,
      sourceUri,
      glspClient,
      initializeDiagramContainer: initializeBookstoreDiagramContainer,
      logger
   });
   if (loadOutcome.status === 'failed') {
      throw new Error(`the diagram did not load: ${describeError(loadOutcome.error)}`);
   }
}
