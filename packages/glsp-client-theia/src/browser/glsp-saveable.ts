/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { RequestSaveModelAction } from '@hydranium/protocol';
// The module path, not the package root: the root also loads GLSP's diagram
// widget, which touches DOM globals at module load, and this module's unit tests
// load it in Node.
import { GLSPSaveable } from '@eclipse-glsp/theia-integration/lib/browser/diagram/glsp-saveable';

/**
 * A `GLSPSaveable` whose every save is a request the server answers, and which
 * stays dirty until that answer arrives.
 *
 * GLSP's sends a `SaveModelAction`, which the server does not answer. It takes
 * the next dirty-state change to clean as the answer, but the editor context
 * reports a change only when the dirty flag changes: the second of two saves
 * gets no answer, and a failed save gets none either. Here each save sends a
 * `RequestSaveModelAction` and settles on the response to that request only:
 * it resolves when the server has saved, rejects when the server rejects it,
 * and rejects when {@link saveTimeout} runs out. A save sent while another is
 * pending is a request of its own, so an edit made between the two is saved.
 *
 * GLSP's also reports not dirty from the moment it sends a save. Theia's exit
 * check asks only whether anything is dirty, so the window closes over a save
 * the server has not finished, and a page reloaded right after Ctrl+S gives no
 * warning. Here the saveable is dirty while any save is pending. GLSP's also
 * gives up after 2 s, and Theia's Save All then counts the save as failed and
 * closes the window anyway, so a slow save of a large model is cut off.
 *
 * The dirty flag still comes from the server. An edit whose dirty-state change
 * has not arrived when Save All runs does not make the saveable dirty, so that
 * edit is not saved.
 *
 * The server answers only where the diagram module registers the request's
 * handler; `AbstractHydraniumGlspDiagramModule` does. A server without it does
 * not advertise the request, and against such a server the saveable is GLSP's:
 * it sends a `SaveModelAction` and reports dirty as GLSP's does. It does not
 * keep only the dirty-while-pending half there, because GLSP's tracks one
 * pending save and a second save overwrites it, so the first would never
 * report clean.
 *
 * The answer means the server has done what its save does, which is not always
 * the disk write: under the `fire-and-forget` `SaveDeliveryPolicy` the server
 * answers before the write finishes and answers a failed write as saved, so a
 * window closed on that answer can still lose the write.
 */
export class HydraniumGlspSaveable extends GLSPSaveable {
   /**
    * How long a save waits for the server's response before it rejects.
    * Long, because the wait only runs out when the server hangs, and a save
    * that rejects in Theia's Save All lets the window close over it.
    */
   protected override saveTimeout = 10_000;
   /** The saves sent and not yet settled. */
   protected readonly pendingSaves = new Set<Promise<void>>();

   override get dirty(): boolean {
      if (!this.serverAnswersSaves()) {
         return super.dirty;
      }
      return this.editorContextService.isDirty || this.pendingSaves.size > 0;
   }

   override save(): Promise<void> {
      if (!this.serverAnswersSaves()) {
         return super.save();
      }
      if (this.editorContextService.isDirty) {
         return this.sendSave();
      }
      // Nothing new to save, but a save still pending has not finished.
      return Promise.all(this.pendingSaves).then(() => undefined);
   }

   /**
    * Whether the server answers a {@link RequestSaveModelAction}. GLSP's model
    * source registers a handler for each kind the server advertises before it
    * requests the model, so the dispatcher knows it from the first save on.
    */
   protected serverAnswersSaves(): boolean {
      return this.actionDispatcher.hasHandler(RequestSaveModelAction.create());
   }

   protected sendSave(): Promise<void> {
      // `request` with a bound of our own rather than GLSP's `requestUntil`:
      // that one forgets a request when it times out, so a late response is
      // dispatched as an action no client handler takes, which rejects.
      // Here a late response settles the forgotten request and nothing else.
      const response = this.actionDispatcher.request(RequestSaveModelAction.create());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
         timer = setTimeout(() => reject(new Error('Save operation timed out')), this.saveTimeout);
      });
      const saving: Promise<void> = Promise.race([response, timedOut])
         .then(() => undefined)
         .finally(() => {
            clearTimeout(timer);
            this.pendingSaves.delete(saving);
            this.onDirtyChangedEmitter.fire(undefined);
         });
      this.pendingSaves.add(saving);
      return saving;
   }
}
