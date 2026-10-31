/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   Bounds,
   type ContainerConfiguration,
   createDiagramOptionsModule,
   DiagramLoader,
   EditorContextService,
   FallbackActionHandler,
   FitToScreenAction,
   type IActionHandler,
   type GLSPActionDispatcher,
   type IDiagramOptions,
   InitializeCanvasBoundsAction,
   STANDALONE_MODULE_CONFIG,
   TYPES
} from '@eclipse-glsp/client';
import { type Disposable, DisposableCollection, type Logger } from '@hydranium/protocol';
import { Container, ContainerModule } from 'inversify';
import { HydraniumGlspActionDispatcher } from './action-dispatcher';
import { type DiagramLoadOutcome, HydraniumDiagramLoader } from './diagram-loader';
import type { HydraniumGlspClient } from './glsp-client';
import { createGlspClientModule } from './glsp-client-module';
import { HydraniumMessageOverlay } from './message-overlay';
import { enableTouchDragging } from './touch-input';
import { HydraniumClientTypes } from './types';

/** Options for {@link mountGlspDiagram}. */
export interface GlspDiagramMountOptions {
   /** The element the diagram renders into. Its `id` becomes the diagram's
    *  `clientId`, from which sprotty derives its base div, so an element
    *  without one is refused rather than left as an empty page. sprotty's
    *  first render replaces the element with one of its own under the same
    *  id, so keep no reference to it: the mount watches the live one. */
   readonly mount: HTMLElement;
   /** The diagram type the GLSP head serves. */
   readonly diagramType: string;
   /** The document the diagram shows. */
   readonly sourceUri: string;
   /** The client over the GLSP head's connection. One client serves every
    *  diagram on the page, each as its own client session. */
   readonly glspClient: HydraniumGlspClient;
   /** The diagram definition's initializer in GLSP's own shape: it receives the
    *  host's modules and appends the definition last, since GLSP's registries
    *  give an element type to whichever module registered it last. */
   readonly initializeDiagramContainer: (container: Container, ...configuration: ContainerConfiguration) => Container;
   /** The host's logger, as {@link createGlspClientModule} takes it. */
   readonly logger?: Logger;
}

/** A diagram {@link mountGlspDiagram} put on a page. */
export interface GlspDiagramMount extends Disposable {
   /** The diagram container, for the services a page reads after the mount. */
   readonly container: Container;
   /** How the load ended. A failed load resolves the mount, so this is where
    *  the caller learns of it; when the failure is not `surfaced`, no overlay
    *  shows it and the caller is the only report left. */
   readonly loadOutcome: DiagramLoadOutcome;
   /**
    * How many edits the server has not answered yet, as
    * {@link HydraniumGlspActionDispatcher.editsInFlight} counts them, for a
    * page that asks before a reload drops one: the diagram's dirty state is
    * set only once the server has answered. None after a failed load, or
    * when the dispatcher is not the framework's. None once disposed either:
    * the server drops the edits the ended session still had queued, though
    * one it was handling still lands.
    */
   readonly editsInFlight: number;
   /**
    * Resolves to `true` once the edits in flight now have been answered or
    * rejected, or to `false` once the dispatcher's bound has passed first, as
    * {@link HydraniumGlspActionDispatcher.whenEditsSettled} does. `true` at
    * once wherever {@link editsInFlight} reads none.
    */
   whenEditsSettled(): Promise<boolean>;
   /** Ends the client session on the server and stops watching the element;
    *  what is drawn in it is left to the host to remove. */
   dispose(): void;
}

/**
 * The canvas kept around the model when it is fitted, in model units before
 * the zoom. Enough that the outermost shape's border is not the edge of the
 * pane and no more, since the padding is taken from the space the fit has.
 */
export const DIAGRAM_FIT_PADDING = 24;

/**
 * Mount a GLSP diagram in a page element: build the container over GLSP's
 * standalone modules and the framework's binder, load the model, and supply
 * what a shell would. Resolves once the model is loaded and framed, so a caller
 * that then reads the model sees the viewport it is drawn in.
 *
 * The accommodations a page needs from whatever hosts the diagram, each silent
 * when missing, so none is optional:
 *
 * - **Framing.** sprotty leaves the viewport at scale 1 and the origin top-left
 *   after a load, so a model wider than the pane is cut off at the right with
 *   no sign anything is missing. The model is fitted with
 *   {@link DIAGRAM_FIT_PADDING}, zooming out only: a fit that zooms in makes a
 *   two-node diagram render four times the size of a ten-node one. To frame
 *   differently, dispatch your own viewport action on the container after the
 *   mount resolves. Register edges with `HydraniumGEdge`: GLSP's own
 *   gives the labels of an edge without bendpoints no finite bounds, and the
 *   fit then blanks the canvas.
 * - **Bounds tracking.** After the first render, sprotty reads its canvas
 *   bounds again on `window.resize` and on nothing else. It culls every shape
 *   outside the bounds it believes it has, so a pane widened by a divider
 *   stays empty in the new space, and it maps pointer positions through their
 *   corner, so after a region above the element folds, a palette drop and a
 *   wheel zoom land off by the distance the element moved. A `ResizeObserver`
 *   on the element and each ancestor, and a `scroll` listener for a container
 *   that scrolls, send the element's box in page coordinates whenever it
 *   differs from the model's. A zero-sized box, which a pane dragged shut
 *   reports, is skipped: a zero canvas culls the whole model.
 * - **Server messages.** GLSP's standalone modules only log the server's
 *   messages and progress reports, so a refused undo changes nothing the user
 *   sees. {@link HydraniumMessageOverlay} shows them on the diagram instead.
 *   Rebind it to a subclass to show them elsewhere.
 * - **Touch input.** sprotty binds mouse events only; see
 *   {@link enableTouchDragging}. Give the element `touch-action: none`.
 * - **The context menu.** GLSP warns on every container built without a
 *   `TYPES.IContextMenuService`, and the console is a page's only log. A no-op
 *   is bound when the host bound none; a menu the host binds, in its
 *   initializer or a module of its own, is left alone.
 *
 * A failed load does not reject: the loader reports it through the logger and,
 * unless the action dispatcher is what failed, on the diagram's status
 * overlay. The mount resolves without the accommodations, which a model that
 * never arrived has no use for, and with the outcome in
 * {@link GlspDiagramMount.loadOutcome}. Any other failure unbinds the
 * container and rejects.
 *
 * The element also needs a height, `position: relative` so the palette stays
 * on it, and its `<svg>` sized to it, or sprotty draws into 300×150.
 */
export async function mountGlspDiagram(options: GlspDiagramMountOptions): Promise<GlspDiagramMount> {
   const { mount } = options;
   if (mount.id === '') {
      throw new Error("mountGlspDiagram: the mount element needs an id, which becomes the diagram's clientId");
   }
   const diagramOptions: IDiagramOptions = {
      clientId: mount.id,
      diagramType: options.diagramType,
      glspClientProvider: async () => options.glspClient,
      sourceUri: options.sourceUri
   };
   // After the standalone modules, since every class the binder binds replaces
   // a token those modules bind.
   const hydraniumModule = new ContainerModule((bind, unbind, isBound, rebind) => {
      createGlspClientModule({ bind, unbind, isBound, rebind }, { logger: options.logger, trackEditsInFlight: true });
      // The fallback is what the standalone modules register for the server's
      // messages and progress, and it only logs them. A singleton, since GLSP
      // resolves it once per action kind and a host may rebind the overlay
      // without a scope.
      bind(HydraniumMessageOverlay).toSelf().inSingletonScope();
      if (isBound(FallbackActionHandler)) {
         rebind<IActionHandler>(FallbackActionHandler)
            .toDynamicValue(context => context.container.get(HydraniumMessageOverlay))
            .inSingletonScope();
         // Through the fallback, so the instance started is the one showing the messages.
         bind(TYPES.IDiagramStartup).toService(FallbackActionHandler);
      }
   });
   const container = options.initializeDiagramContainer(
      new Container(),
      createDiagramOptionsModule(diagramOptions),
      STANDALONE_MODULE_CONFIG,
      hydraniumModule
   );
   // After the container is built rather than in a module, so the host's own
   // binding wins wherever its module sits in the order.
   if (!container.isBound(TYPES.IContextMenuService)) {
      container.bind(TYPES.IContextMenuService).toConstantValue({ show: () => undefined });
   }

   const toDispose = new DisposableCollection();
   // Pushed first, so it runs last: `unbindAll` reaches `disposeClientSession`
   // through the model source's pre-destroy hook, after the listeners are gone.
   toDispose.push({ dispose: () => container.unbindAll() });
   // Set once the mount loaded with the framework's dispatcher, until disposed.
   let editsDispatcher: HydraniumGlspActionDispatcher | undefined;
   const dispose = (): void => {
      editsDispatcher = undefined;
      toDispose.dispose();
   };
   const mountWith = (loadOutcome: DiagramLoadOutcome): GlspDiagramMount => ({
      container,
      loadOutcome,
      get editsInFlight() {
         return editsDispatcher?.editsInFlight ?? 0;
      },
      whenEditsSettled: () => editsDispatcher?.whenEditsSettled() ?? Promise.resolve(true),
      dispose
   });
   try {
      const loader = container.get(DiagramLoader);
      await loader.load();
      // A loader that is not the framework's rejects on a failure instead.
      const loadOutcome = (loader instanceof HydraniumDiagramLoader ? loader.loadOutcome : undefined) ?? { status: 'loaded' };
      // A model that never arrived has no use for the accommodations, and when
      // the dispatcher is what failed, every later dispatch rejects too.
      if (loadOutcome.status === 'failed') {
         return mountWith(loadOutcome);
      }
      const dispatcher = container.get<GLSPActionDispatcher>(TYPES.IActionDispatcher);
      // The bounds the fit measures come from the hidden rendering pass inside
      // `load`; a fit dispatched before it has nothing to measure and leaves the
      // viewport where it was.
      await dispatcher.dispatch(FitToScreenAction.create([], { padding: DIAGRAM_FIT_PADDING, maxZoom: 1, animate: false }));

      // By id and not through `mount`: the load's first render replaced that
      // element, and a listener on the replaced one never fires.
      const live = document.getElementById(mount.id);
      if (live === null) {
         throw new Error(`mountGlspDiagram: the element '${mount.id}' left the document while the diagram loaded`);
      }
      toDispose.push(
         trackCanvasBounds(live, dispatcher, container.get(EditorContextService), container.get<Logger>(HydraniumClientTypes.Logger))
      );
      toDispose.push(enableTouchDragging(live));
      if (dispatcher instanceof HydraniumGlspActionDispatcher) {
         editsDispatcher = dispatcher;
      }
      return mountWith(loadOutcome);
   } catch (err: unknown) {
      // The caller gets no mount to dispose, so the session would outlive it.
      toDispose.dispose();
      throw err;
   }
}

function trackCanvasBounds(
   mount: HTMLElement,
   dispatcher: GLSPActionDispatcher,
   editorContext: EditorContextService,
   logger: Logger
): Disposable {
   const update = (): void => {
      const box = mount.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) {
         return;
      }
      const bounds = { x: box.left + window.scrollX, y: box.top + window.scrollY, width: box.width, height: box.height };
      // Against the model's bounds rather than the last ones sent, since sprotty
      // sets them too on `window.resize`; and skipped when equal, since every
      // page scroll lands here and each dispatch redraws the diagram.
      if (!Bounds.equals(bounds, editorContext.canvasBounds)) {
         dispatcher
            .dispatch(InitializeCanvasBoundsAction.create(bounds))
            .catch((err: unknown) => logger.error("Failed to update the diagram's canvas bounds", err));
      }
   };
   const observer = new ResizeObserver(update);
   for (let element: HTMLElement | null = mount; element !== null; element = element.parentElement) {
      observer.observe(element);
   }
   document.addEventListener('scroll', update, { capture: true, passive: true });
   return {
      dispose: () => {
         observer.disconnect();
         document.removeEventListener('scroll', update, { capture: true });
      }
   };
}
