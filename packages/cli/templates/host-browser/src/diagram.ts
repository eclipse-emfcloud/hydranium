// The GLSP part of the page: the __GRAMMAR__ diagram of the file the page
// shows, drawn by the client module every host of this project mounts.

import type { WorkerHeads } from '@hydranium/client-browser';
import { glspConnection, type GlspDiagramMount, HydraniumGlspClient, mountGlspDiagram } from '@hydranium/glsp-client';
import { describeError, type Logger } from '@hydranium/protocol';
import { initialize__GRAMMAR__DiagramContainer } from '__CLIENT_PACKAGE__';
import { __GRAMMAR_ID_CONST___DIAGRAM_TYPE, __GRAMMAR_ID_CONST___LANGUAGE } from '__PROTOCOL_PACKAGE__';
import { appendLog } from './log.js';
import type { ShownFile } from './shown-file.js';

/**
 * Show the diagram of the file the page shows, and of each file it switches
 * to, and hand back what reads the mount shown now, if it loaded. A file of
 * another language hides the pane. `beforeLeave` runs on the shown mount
 * before a switch disposes it, while the diagram takes no input; when it
 * throws, that mount stays shown and the page switches back to its file.
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
         // Inert, since an edit made while it runs would outlast its wait and be dropped with the mount.
         const shown = document.getElementById('diagram') as HTMLElement;
         shown.inert = true;
         try {
            await beforeLeave(mounted);
         } catch (error: unknown) {
            // The diagram stays on its file, so the switch goes back to it.
            shownFile.show(mountedUri);
            throw error;
         } finally {
            shown.inert = false;
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
      pane.hidden = !__GRAMMAR_ID_CONST___LANGUAGE.fileExtensions.some(extension => uri.endsWith(extension));
      if (pane.hidden) {
         return;
      }
      mounted = await mountGlspDiagram({
         mount: element,
         diagramType: __GRAMMAR_ID_CONST___DIAGRAM_TYPE,
         sourceUri: uri,
         glspClient,
         initializeDiagramContainer: initialize__GRAMMAR__DiagramContainer,
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
      // Derived, so a dropped failure is reported, and before the catch below, so the caller resumes before the next switch starts.
      const handed = shown.then(() => undefined);
      switching = shown.catch(() => undefined);
      return handed;
   };
   // Before the first mount, since the page can switch while it loads.
   shownFile.onDidChange(uri => {
      follow(uri).catch((error: unknown) => appendLog(describeError(error)));
   });
   // A first file that fails to load is logged as a later switch's is, so the
   // page still arms what follows and the switch can reach a file that loads.
   await follow(shownFile.current()).catch((error: unknown) => appendLog(describeError(error)));
   // Asks before a reload or a closed tab drops an edit the server has not
   // answered yet, which neither dirty state nor the editor shows until then.
   window.addEventListener('beforeunload', event => {
      if ((mounted?.editsInFlight ?? 0) > 0) {
         event.preventDefault();
      }
   });
   // Only a mount that loaded: one that failed has nothing to save.
   return () => (mountedUri === undefined ? undefined : mounted);
}

/**
 * Wait for the edits of `diagram` the server has not answered yet, before a
 * save, which would miss them, or before a switch disposes it, as the server
 * drops what an ended session still had queued and the reload guard reads only
 * the diagram shown. Throws when one stays unanswered, so the save does not
 * report success and the switch keeps the diagram shown.
 */
export async function settleDiagramEdits(diagram: GlspDiagramMount | undefined): Promise<void> {
   if ((await diagram?.whenEditsSettled()) === false) {
      throw new Error('the server has not answered an edit of this diagram yet');
   }
}
