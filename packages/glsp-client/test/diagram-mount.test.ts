/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import {
   type ContainerConfiguration,
   DiagramLoader,
   EditorContextService,
   FitToScreenAction,
   GLSPActionDispatcher,
   GLSPHiddenBoundsUpdater,
   type IDiagramOptions,
   InitializeCanvasBoundsAction,
   RankedSelectMouseListener,
   STANDALONE_MODULE_CONFIG,
   StatusOverlay,
   TYPES
} from '@eclipse-glsp/client';
import { NoopLogger } from '@hydranium/protocol';
import { Container, type ContainerModule, type interfaces } from 'inversify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DiagramLoadOutcome, HydraniumDiagramLoader } from '../src/diagram-loader';
import { DIAGRAM_FIT_PADDING, type GlspDiagramMountOptions, mountGlspDiagram } from '../src/diagram-mount';
import type { HydraniumGlspClient } from '../src/glsp-client';
import { HydraniumClientTypes } from '../src/types';

/** The calls the mount makes on the container's services, in order. */
type Call = ['load'] | ['dispatch', unknown];

/** A `ResizeObserver` stand-in that lets a test fire the callback it was built with. */
class ResizeObserverDouble {
   static instances: ResizeObserverDouble[] = [];
   readonly observed: unknown[] = [];
   disconnected = false;
   constructor(readonly callback: () => void) {
      ResizeObserverDouble.instances.push(this);
   }
   observe(target: unknown): void {
      this.observed.push(target);
   }
   disconnect(): void {
      this.disconnected = true;
      teardown.push('disconnect');
   }
}

/** A loader that settles with the outcome a test sets, as the framework's own loader does. */
class DiagramLoaderDouble extends HydraniumDiagramLoader {
   constructor(
      readonly calls: Call[],
      readonly outcomeAfterLoad: DiagramLoadOutcome
   ) {
      super();
   }
   override async load(): Promise<void> {
      this.calls.push(['load']);
      this.settle(this.outcomeAfterLoad);
   }
}

/** What dispose tore down, in order. */
let teardown: string[] = [];

/** The GLSP default tokens the binder replaces, bound so each `rebind` finds something. */
const GLSP_DEFAULT_TOKENS: interfaces.ServiceIdentifier<unknown>[] = [
   GLSPActionDispatcher,
   DiagramLoader,
   GLSPHiddenBoundsUpdater,
   StatusOverlay,
   RankedSelectMouseListener,
   TYPES.ILogger
];

describe('mountGlspDiagram', () => {
   const glspClient = {} as HydraniumGlspClient;
   const logger = new NoopLogger();
   let calls: Call[];
   let loadOutcome: DiagramLoadOutcome;
   let dispatchFails: boolean;
   let box: { left: number; top: number; width: number; height: number };
   interface ElementDouble {
      id: string;
      parentElement: ElementDouble | null;
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
      getBoundingClientRect(): typeof box;
   }
   /** The bounds the model holds, which sprotty also sets on a window resize. */
   let modelBounds: { x: number; y: number; width: number; height: number };
   let documentDouble: {
      getElementById(id: string): ElementDouble | null;
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
   };
   /** The element the page passes, which the first render replaces. */
   let mount: ElementDouble;
   /** The element sprotty put in its place, found by id after the load. */
   let live: ElementDouble;
   /** The element `live` sits in. */
   let pane: ElementDouble;
   /** What the initializer under test was handed. */
   let configuration: ContainerConfiguration;
   let container: Container;

   /** An initializer that keeps the configuration and binds the services the mount reaches. */
   function initializeDiagramContainer(target: Container, ...modules: ContainerConfiguration): Container {
      configuration = modules;
      target.bind(DiagramLoader).toConstantValue(new DiagramLoaderDouble(calls, loadOutcome));
      target.bind(TYPES.IActionDispatcher).toConstantValue({
         dispatch: async (action: unknown) => {
            calls.push(['dispatch', action]);
            if (dispatchFails) {
               throw new Error('dispatcher failed to initialize');
            }
         }
      });
      target.bind(HydraniumClientTypes.Logger).toConstantValue(logger);
      target.bind(EditorContextService).toConstantValue({
         get canvasBounds() {
            return modelBounds;
         }
      } as unknown as EditorContextService);
      return (container = target);
   }

   function options(overrides: Partial<GlspDiagramMountOptions> = {}): GlspDiagramMountOptions {
      return {
         mount: mount as unknown as HTMLElement,
         diagramType: 'diagram-one',
         sourceUri: 'file:///a.x',
         glspClient,
         initializeDiagramContainer,
         logger,
         ...overrides
      };
   }

   beforeEach(() => {
      calls = [];
      loadOutcome = { status: 'loaded' };
      dispatchFails = false;
      teardown = [];
      box = { left: 5, top: 7, width: 300, height: 200 };
      modelBounds = { x: -1, y: -1, width: -1, height: -1 };
      const element = (id: string, parentElement: ElementDouble | null): ElementDouble => ({
         id,
         parentElement,
         addEventListener: vi.fn(),
         removeEventListener: vi.fn(),
         getBoundingClientRect: () => box
      });
      mount = element('mount-one', null);
      pane = element('pane-one', null);
      live = element('mount-one', pane);
      ResizeObserverDouble.instances = [];
      vi.stubGlobal('ResizeObserver', ResizeObserverDouble);
      vi.stubGlobal('window', { scrollX: 100, scrollY: 1000 });
      documentDouble = {
         getElementById: (id: string) => (id === 'mount-one' ? live : null),
         addEventListener: vi.fn(),
         removeEventListener: vi.fn()
      };
      vi.stubGlobal('document', documentDouble);
   });

   afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
   });

   it('refuses an element with no id, since the id is the base div sprotty renders into', async () => {
      mount.id = '';
      await expect(mountGlspDiagram(options())).rejects.toThrow(/id/);
      expect(calls).toEqual([]);
   });

   it("hands the initializer the diagram options over the element's id, the standalone modules and the framework binder, in that order", async () => {
      await mountGlspDiagram(options());
      expect(configuration).toHaveLength(3);
      expect(configuration[1]).toBe(STANDALONE_MODULE_CONFIG);
      const optionsContainer = new Container();
      optionsContainer.load(configuration[0] as ContainerModule);
      const diagramOptions = optionsContainer.get<IDiagramOptions>(TYPES.IDiagramOptions);
      expect(diagramOptions).toMatchObject({ clientId: 'mount-one', diagramType: 'diagram-one', sourceUri: 'file:///a.x' });
      await expect(diagramOptions.glspClientProvider()).resolves.toBe(glspClient);
      const binderContainer = new Container();
      for (const token of GLSP_DEFAULT_TOKENS) {
         binderContainer.bind(token).toConstantValue({});
      }
      binderContainer.load(configuration[2] as ContainerModule);
      expect(binderContainer.get(HydraniumClientTypes.Logger)).toBe(logger);
   });

   it('loads the model and then fits it without zooming in, before it resolves', async () => {
      const mounted = await mountGlspDiagram(options());
      expect(mounted.loadOutcome).toEqual({ status: 'loaded' });
      expect(calls).toEqual([
         ['load'],
         ['dispatch', FitToScreenAction.create([], { padding: DIAGRAM_FIT_PADDING, maxZoom: 1, animate: false })]
      ]);
   });

   it('binds a no-op context menu when the host bound none, so GLSP stops warning', async () => {
      await mountGlspDiagram(options());
      expect(container.get<{ show: unknown }>(TYPES.IContextMenuService).show).toBeTypeOf('function');
   });

   it("leaves the host's context menu alone", async () => {
      const menu = { show: () => undefined };
      await mountGlspDiagram(
         options({
            initializeDiagramContainer: (target, ...modules) => {
               target.bind(TYPES.IContextMenuService).toConstantValue(menu);
               return initializeDiagramContainer(target, ...modules);
            }
         })
      );
      expect(container.get(TYPES.IContextMenuService)).toBe(menu);
   });

   it('watches the element the render put in place, not the one it replaced', async () => {
      await mountGlspDiagram(options());
      expect(ResizeObserverDouble.instances[0].observed[0]).toBe(live);
      expect(mount.addEventListener).not.toHaveBeenCalled();
      expect(live.addEventListener).toHaveBeenCalled();
   });

   it('refuses to finish when the element left the document while the diagram loaded', async () => {
      const unbindAll = vi.spyOn(Container.prototype, 'unbindAll');
      live.id = 'other';
      vi.stubGlobal('document', { getElementById: () => null });
      await expect(mountGlspDiagram(options())).rejects.toThrow(/left the document/);
      expect(unbindAll).toHaveBeenCalledTimes(1);
   });

   it('resolves after a failed load without fitting or watching the element, so the failure report stays on screen', async () => {
      const unbindAll = vi.spyOn(Container.prototype, 'unbindAll');
      loadOutcome = { status: 'failed', error: new Error('no dispatcher'), surfaced: false };
      dispatchFails = true;
      const mounted = await mountGlspDiagram(options());
      expect(mounted.loadOutcome).toEqual(loadOutcome);
      expect(calls).toEqual([['load']]);
      expect(ResizeObserverDouble.instances).toEqual([]);
      expect(live.addEventListener).not.toHaveBeenCalled();
      mounted.dispose();
      expect(unbindAll).toHaveBeenCalledTimes(1);
   });

   it('unbinds the container when the fit fails, since no caller gets a mount to dispose', async () => {
      const unbindAll = vi.spyOn(Container.prototype, 'unbindAll');
      dispatchFails = true;
      await expect(mountGlspDiagram(options())).rejects.toThrow(/dispatcher failed/);
      expect(unbindAll).toHaveBeenCalledTimes(1);
   });

   it('stops watching the element and unbinds the container when the touch shim fails', async () => {
      const unbindAll = vi.spyOn(Container.prototype, 'unbindAll');
      live.addEventListener.mockImplementation(() => {
         throw new Error('no listeners');
      });
      await expect(mountGlspDiagram(options())).rejects.toThrow(/no listeners/);
      expect(ResizeObserverDouble.instances[0].disconnected).toBe(true);
      expect(unbindAll).toHaveBeenCalledTimes(1);
   });

   it('tells sprotty the canvas bounds in page coordinates whenever the element is resized', async () => {
      await mountGlspDiagram(options());
      const [observer] = ResizeObserverDouble.instances;
      calls = [];
      observer.callback();
      expect(calls).toEqual([['dispatch', InitializeCanvasBoundsAction.create({ x: 105, y: 1007, width: 300, height: 200 })]]);
   });

   it('watches every ancestor too, since a region above that folds moves the element without resizing it', async () => {
      await mountGlspDiagram(options());
      expect(ResizeObserverDouble.instances[0].observed).toEqual([live, pane]);
   });

   it('tells sprotty the new bounds when a container around the element scrolls, which moves it on the page', async () => {
      await mountGlspDiagram(options());
      const [type, listener, listenerOptions] = documentDouble.addEventListener.mock.calls[0];
      expect([type, listenerOptions]).toEqual(['scroll', { capture: true, passive: true }]);
      calls = [];
      box = { left: 5, top: 50, width: 300, height: 200 };
      (listener as () => void)();
      expect(calls).toEqual([['dispatch', InitializeCanvasBoundsAction.create({ x: 105, y: 1050, width: 300, height: 200 })]]);
   });

   it('leaves the bounds alone when the model already has them, so scrolling the page does not redraw the diagram', async () => {
      await mountGlspDiagram(options());
      modelBounds = { x: 105, y: 1007, width: 300, height: 200 };
      calls = [];
      ResizeObserverDouble.instances[0].callback();
      expect(calls).toEqual([]);
   });

   it('logs a bounds update the dispatcher rejects, which no caller is waiting on to catch', async () => {
      const error = vi.spyOn(logger, 'error');
      await mountGlspDiagram(options());
      dispatchFails = true;
      ResizeObserverDouble.instances[0].callback();
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringMatching(/canvas bounds/), expect.any(Error)));
   });

   it('skips a zero-sized box, which a pane dragged shut reports, since a zero canvas culls every shape', async () => {
      await mountGlspDiagram(options());
      calls = [];
      box = { left: 5, top: 7, width: 0, height: 200 };
      ResizeObserverDouble.instances[0].callback();
      expect(calls).toEqual([]);
   });

   it('re-emits touch gestures on the element', async () => {
      await mountGlspDiagram(options());
      const types = live.addEventListener.mock.calls.map(([type]) => type);
      expect(types).toEqual(expect.arrayContaining(['pointerdown', 'pointermove', 'pointerup', 'pointercancel']));
   });

   it('stops watching the element and then unbinds the container when disposed', async () => {
      const unbindAll = vi.spyOn(Container.prototype, 'unbindAll').mockImplementation(() => void teardown.push('unbindAll'));
      const mounted = await mountGlspDiagram(options());
      expect(mounted.container).toBe(container);
      mounted.dispose();
      expect(unbindAll).toHaveBeenCalledTimes(1);
      // The listeners first: the unbind ends the session on the server, and a
      // resize or touch arriving after it would dispatch into a dead container.
      expect(teardown).toEqual(['disconnect', 'unbindAll']);
      expect(documentDouble.removeEventListener).toHaveBeenCalledWith('scroll', documentDouble.addEventListener.mock.calls[0][1], {
         capture: true
      });
      expect(live.removeEventListener.mock.calls.map(([type]) => type).sort()).toEqual([
         'pointercancel',
         'pointerdown',
         'pointermove',
         'pointerup'
      ]);
   });
});
