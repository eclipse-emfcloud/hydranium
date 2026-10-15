// Save for a page with no editor: the diagram's edits are saved through the
// GLSP head, which writes them to the store the worker keeps in IndexedDB.

import { EditorContextService, type IActionDispatcher, TYPES } from '@eclipse-glsp/client';
import type { GlspDiagramMount } from '@hydranium/glsp-client';
import { describeError, RequestSaveModelAction } from '@hydranium/protocol';
import { setStatus } from './log.js';

/** Save `diagram` through the GLSP head: resolves once the save has written, rejects when it failed. */
async function saveDiagram(diagram: GlspDiagramMount): Promise<void> {
   await diagram.container.get<IActionDispatcher>(TYPES.IActionDispatcher).request(RequestSaveModelAction.create());
}

/**
 * Save the diagram the page switches away from: Save and the reload guard reach
 * only the diagram shown, so an edit left in another file would otherwise be
 * lost unasked. Saved whether or not it reads as dirty, since an edit made just
 * before the switch is marked dirty only once the server has answered it; the
 * server runs the save after that edit, and a save of a clean diagram writes
 * nothing.
 */
export async function saveBeforeLeaving(diagram: GlspDiagramMount): Promise<void> {
   await saveDiagram(diagram).catch((error: unknown) => {
      setStatus(`save failed: ${describeError(error)}`);
      throw error;
   });
}

/**
 * Arm the page's Save and Ctrl+S for the diagram `shownDiagram` reads at the
 * time, and ask before a reload drops an unsaved edit.
 */
export function armDiagramSave(shownDiagram: () => GlspDiagramMount | undefined): void {
   const save = (): void => {
      const diagram = shownDiagram();
      if (diagram === undefined) {
         setStatus('no diagram to save');
         return;
      }
      saveDiagram(diagram).then(
         () => setStatus('saved the diagram'),
         (error: unknown) => setStatus(`save failed: ${describeError(error)}`)
      );
   };
   const saveButton = document.getElementById('save') as HTMLButtonElement;
   saveButton.addEventListener('click', save);
   // Ctrl+S (Cmd+S) saves too, in place of the browser's "Save page as".
   window.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
         event.preventDefault();
         save();
      }
   });
   window.addEventListener('beforeunload', event => {
      if (shownDiagram()?.container.get(EditorContextService).isDirty) {
         event.preventDefault();
      }
   });
   saveButton.hidden = false;
}
