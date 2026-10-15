// The GLSP part of the page: the __GRAMMAR__ diagram of one document, drawn by
// the client module every host of this project mounts.

import type { WorkerHeads } from '@hydranium/client-browser';
import { glspConnection, HydraniumGlspClient, mountGlspDiagram } from '@hydranium/glsp-client';
import { describeError, type Logger } from '@hydranium/protocol';
import { initialize__GRAMMAR__DiagramContainer } from '__CLIENT_PACKAGE__';
import { __GRAMMAR_ID_CONST___DIAGRAM_TYPE } from '__PROTOCOL_PACKAGE__';

/** Show the diagram of `sourceUri` in the page's diagram pane. */
export async function mountDiagram(connection: WorkerHeads['glsp'], sourceUri: string, logger: Logger): Promise<void> {
   // Shown before the mount, which measures the element it draws into.
   (document.getElementById('diagram-pane') as HTMLElement).hidden = false;
   const glspClient = new HydraniumGlspClient({ id: 'diagram', connectionProvider: glspConnection(connection) });
   const { loadOutcome } = await mountGlspDiagram({
      mount: document.getElementById('diagram') as HTMLElement,
      diagramType: __GRAMMAR_ID_CONST___DIAGRAM_TYPE,
      sourceUri,
      glspClient,
      initializeDiagramContainer: initialize__GRAMMAR__DiagramContainer,
      logger
   });
   if (loadOutcome.status === 'failed') {
      throw new Error(`the diagram did not load: ${describeError(loadOutcome.error)}`);
   }
}
