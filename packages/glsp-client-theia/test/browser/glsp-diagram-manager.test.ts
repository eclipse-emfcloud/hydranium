/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DiagramLoader } from '@eclipse-glsp/client';
import { type GLSPDiagramWidget } from '@eclipse-glsp/theia-integration/lib/browser';
import { type GLSPDiagramLanguage } from '@eclipse-glsp/theia-integration/lib/common';
import { type WidgetOpenerOptions } from '@theia/core/lib/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HydraniumGlspClientContribution } from '../../src/browser/client-contribution.js';
import { HydraniumDiagramLoader } from '../../src/browser/diagram-loader.js';
import { HydraniumGlspDiagramWidget } from '../../src/browser/diagram-widget.js';
import { AbstractHydraniumGlspDiagramManager } from '../../src/browser/glsp-diagram-manager.js';
import { DefaultWindowSessionService, type WindowSessionService } from '../../src/browser/window-session.js';

/**
 * What the base class received, so the assertion is on the options this override
 * HANDS ON rather than on a return value both branches produce.
 */
let received: Array<WidgetOpenerOptions | undefined>;

// `@eclipse-glsp/theia-integration` is mocked rather than loaded: pre-bundling
// it drags in Theia browser modules that touch DOM globals at import time, so
// this package's dep optimizer deliberately leaves it out and every suite here
// mocks it instead.
//
// The consequence, stated rather than hidden: this suite cannot execute
// upstream's `determineNavigations`, so it does not reproduce the throw itself.
// It pins the CONTRACT the override exists to satisfy — an `undefined`
// `selection` never reaches the base, a real one always does — which is the half
// that can regress here. The throw was confirmed by reading upstream's
// `OptionsWithSelection.is` (`'selection' in options`, true for an explicit
// `undefined`, guarding an `Object.keys` on that value) and observed in a
// running app.
vi.mock('@eclipse-glsp/theia-integration', () => ({
   GLSPDiagramManager: class {
      createdWidget?: unknown;
      protected handleNavigations(_widget: unknown, options?: WidgetOpenerOptions): boolean {
         received.push(options);
         return options !== undefined && 'selection' in options;
      }
      async createWidget(): Promise<unknown> {
         return this.createdWidget;
      }
      protected createDiagramOptions(options: { uri: string }): object {
         return { clientId: 'counted_0', sourceUri: options.uri };
      }
   },
   BaseGLSPClientContribution: class {},
   GLSPDiagramWidget: class {
      events: string[] = [];
      /** Lumino's widget detaches, and GLSP's stores its viewport, when its parent is cleared. */
      set parent(_parent: unknown) {
         this.events.push('detach');
      }
      dispose(): void {
         this.events.push('dispose');
      }
   }
}));
// Its browser barrel pulls `@theia/output`, which touches DOM globals at load.
vi.mock('@hydranium/client-theia/lib/browser', () => ({
   ChannelLogger: class ChannelLogger {},
   ConnectionReporter: Symbol('ConnectionReporter')
}));
vi.mock('@theia/workspace/lib/browser', () => ({ WorkspaceService: class WorkspaceService {} }));
vi.mock('../../src/browser/glsp-saveable', () => ({ HydraniumGlspSaveable: class HydraniumGlspSaveable {} }));

const LANGUAGE: GLSPDiagramLanguage = {
   diagramType: 'test-diagram',
   label: 'Test Diagram',
   contributionId: 'test-contribution',
   fileExtensions: ['.tst']
};

class TestDiagramManager extends AbstractHydraniumGlspDiagramManager {
   protected readonly diagramLanguage = LANGUAGE;
   protected readonly managerLabel = 'Test Diagram Editor';

   navigate(options?: WidgetOpenerOptions): boolean {
      return this.handleNavigations({} as GLSPDiagramWidget, options);
   }
}

describe('AbstractHydraniumGlspDiagramManager.handleNavigations', () => {
   beforeEach(() => {
      received = [];
   });

   it("drops a present-but-undefined selection, the shape Theia's file picker sends", () => {
      // `QuickFileOpenService.buildOpenerOptions` returns `{ selection: range }`,
      // and `range` is undefined unless the typed query carried a `:line:column`
      // suffix — so this is the ordinary case of opening a diagram by name, not
      // an edge one.
      new TestDiagramManager().navigate({ selection: undefined } as WidgetOpenerOptions);

      expect(received).toHaveLength(1);
      expect(received[0] && 'selection' in received[0]).toBe(false);
   });

   it('passes a real selection through untouched', () => {
      // The half that stops the fix from being "always drop selection", which
      // would satisfy the undefined-selection case while silently breaking
      // every caller that reveals a diagram at a position.
      const selection = { start: { line: 3, character: 7 }, end: { line: 3, character: 7 } };

      const navigated = new TestDiagramManager().navigate({ selection } as WidgetOpenerOptions);

      expect(navigated).toBe(true);
      expect(received[0]).toEqual({ selection });
   });

   it('leaves options that carry no selection key alone', () => {
      new TestDiagramManager().navigate({ mode: 'activate' } as WidgetOpenerOptions);

      expect(received[0]).toEqual({ mode: 'activate' });
   });

   it('leaves absent options absent, rather than substituting an empty object', () => {
      new TestDiagramManager().navigate(undefined);

      expect(received[0]).toBeUndefined();
   });
});

describe('AbstractHydraniumGlspDiagramManager.reopen', () => {
   const title = (name: string): { owner: unknown } => ({ owner: { name } });

   class ReopenTestManager extends TestDiagramManager {
      readonly opened: Array<{ uri: unknown; options?: WidgetOpenerOptions }> = [];
      override async open(uri: GLSPDiagramWidget['uri'], options?: WidgetOpenerOptions): Promise<GLSPDiagramWidget> {
         this.opened.push({ uri, options });
         events.push('open');
         return {} as GLSPDiagramWidget;
      }
   }

   let events: string[];
   let manager: ReopenTestManager;
   let widget: HydraniumGlspDiagramWidget;

   const placeIn = (titles: unknown[], active = false): void => {
      Object.assign(manager, {
         shell: {
            getTabBarFor: () => ({ titles, currentTitle: widget.title }),
            activeWidget: active ? widget : undefined
         }
      });
   };

   beforeEach(() => {
      manager = new ReopenTestManager();
      Object.assign(manager, { diagramServiceProvider: { getGLSPClientContribution: () => undefined } });
      widget = new HydraniumGlspDiagramWidget();
      events = (widget as unknown as { events: string[] }).events;
      Object.defineProperties(widget, {
         title: { value: title('diagram') },
         uri: { value: 'file:///orders/fulfillment.process' },
         options: { value: { editMode: 'editable' } }
      });
   });

   it("reopens on the widget's request, after its left neighbour, detaching it before the dispose", async () => {
      const left = title('left');
      placeIn([left, widget.title, title('right')]);
      Object.assign(manager, { createdWidget: widget });
      await manager.createWidget({});

      (widget as unknown as { reopenRequestEmitter: { fire(): void } }).reopenRequestEmitter.fire();
      await vi.waitFor(() => expect(manager.opened).toHaveLength(1));

      // Detached first, so the viewport is stored while the container still
      // resolves; disposed before the open, since the fresh widget takes its id.
      expect(events).toEqual(['detach', 'dispose', 'open']);
      expect(manager.opened[0]).toEqual({
         uri: 'file:///orders/fulfillment.process',
         options: { mode: 'reveal', editMode: 'editable', widgetOptions: { ref: left.owner, mode: 'tab-after' } }
      });
   });

   it('reopens a first tab before its right neighbour, and activates an active one', async () => {
      const right = title('right');
      placeIn([widget.title, right], true);

      await manager.reopen(widget);

      expect(manager.opened[0].options).toMatchObject({ mode: 'activate', widgetOptions: { ref: right.owner, mode: 'tab-before' } });
   });

   /** Each reopen places its replacement next to a neighbour, and a reopen
    *  running alongside would take that neighbour out of the layout. */
   it('reopens one diagram at a time', async () => {
      const log: string[] = [];
      const second = new HydraniumGlspDiagramWidget();
      Object.defineProperties(second, {
         title: { value: title('second') },
         uri: { value: 'file:///orders/returns.process' },
         options: { value: { editMode: 'editable' } }
      });
      Object.defineProperty(widget, 'parent', { set: () => log.push('detach first') });
      Object.defineProperty(second, 'parent', { set: () => log.push('detach second') });
      let release!: () => void;
      const released = new Promise<void>(resolve => (release = resolve));
      Object.assign(manager, {
         open: async (uri: string) => {
            log.push(`open ${uri}`);
            await released;
            log.push(`opened ${uri}`);
         }
      });
      placeIn([widget.title, second.title]);

      const both = Promise.all([manager.reopen(widget), manager.reopen(second)]);
      await vi.waitFor(() => expect(log).toContain('open file:///orders/fulfillment.process'));
      expect(log).not.toContain('detach second');
      release();
      await both;

      expect(log).toEqual([
         'detach first',
         'open file:///orders/fulfillment.process',
         'opened file:///orders/fulfillment.process',
         'detach second',
         'open file:///orders/returns.process',
         'opened file:///orders/returns.process'
      ]);
   });

   /** A Retry can land while a batch still holds the same diagram. */
   it('skips a diagram that a queued reopen already replaced', async () => {
      let disposed = false;
      Object.defineProperty(widget, 'isDisposed', { get: () => disposed });
      Object.assign(widget, { dispose: () => (disposed = true) });
      placeIn([widget.title]);

      await Promise.all([manager.reopen(widget), manager.reopen(widget)]);

      expect(manager.opened).toHaveLength(1);
   });

   it('reopens a diagram alone in its tab bar where a new one opens', async () => {
      placeIn([widget.title]);

      await manager.reopen(widget);

      expect(manager.opened[0].options?.widgetOptions).toBeUndefined();
   });
});

describe('AbstractHydraniumGlspDiagramManager on client events', () => {
   class EventTestManager extends TestDiagramManager {
      readonly reopened: unknown[] = [];
      widgets: GLSPDiagramWidget[] = [];
      override get all(): GLSPDiagramWidget[] {
         return this.widgets;
      }
      override async reopen(widget: GLSPDiagramWidget): Promise<void> {
         this.reopened.push(widget);
      }
   }

   const diagram = (status?: 'loaded' | 'failed'): GLSPDiagramWidget => {
      const loader = new HydraniumDiagramLoader();
      Object.assign(loader, { outcome: status && { status } });
      return { diContainer: { get: (id: unknown) => (id === DiagramLoader ? loader : undefined) } } as unknown as GLSPDiagramWidget;
   };

   const setUp = (): { manager: EventTestManager; contribution: HydraniumGlspClientContribution } => {
      const manager = new EventTestManager();
      const contribution = new HydraniumGlspClientContribution({ languageContributionId: 'test-contribution' });
      Object.assign(manager, { diagramServiceProvider: { getGLSPClientContribution: () => contribution } });
      return { manager, contribution };
   };
   const fire = (contribution: HydraniumGlspClientContribution, emitter: 'clientLostEmitter' | 'clientStartedEmitter'): void =>
      (contribution as unknown as Record<string, { fire(value?: unknown): void }>)[emitter].fire({});

   /** None of them has a server behind it any more. */
   it('reopens every diagram once the client is lost', async () => {
      const { manager, contribution } = setUp();
      await manager.createWidget({});
      manager.widgets = [diagram('loaded'), diagram(), diagram('failed')];

      fire(contribution, 'clientLostEmitter');

      expect(manager.reopened).toEqual(manager.widgets);
   });

   /** A diagram whose load failed stays failed otherwise, though a client is up now. */
   it('reopens only the failed diagrams once a client starts', async () => {
      const { manager, contribution } = setUp();
      await manager.createWidget({});
      const failed = diagram('failed');
      manager.widgets = [diagram('loaded'), diagram(), failed];

      fire(contribution, 'clientStartedEmitter');

      expect(manager.reopened).toEqual([failed]);
   });
});

describe('AbstractHydraniumGlspDiagramManager client ids', () => {
   const windowSessions = new DefaultWindowSessionService();

   class IdManager extends TestDiagramManager {
      protected override readonly windowSessions: WindowSessionService = windowSessions;

      clientIdFor(uri: string, editMode = 'editable', extra: Record<string, unknown> = {}): string {
         const options = { uri, editMode, ...extra } as Parameters<IdManager['createDiagramOptions']>[0];
         return (this.createDiagramOptions(options) as { clientId: string }).clientId;
      }
   }

   it('gives two widgets of one document two ids when an option an adopter adds sets them apart', () => {
      const manager = new IdManager();

      expect(manager.clientIdFor('file:///a.tst', 'editable', { pane: 'left' })).not.toBe(
         manager.clientIdFor('file:///a.tst', 'editable', { pane: 'right' })
      );
      expect(manager.clientIdFor('file:///a.tst', 'editable', { pane: 'left' })).toBe(
         manager.clientIdFor('file:///a.tst', 'editable', { pane: 'left' })
      );
   });

   it('gives a document open in two edit modes two ids, so neither takes the other’s session over', () => {
      const editable = new IdManager().clientIdFor('file:///a.tst', 'editable');

      expect(new IdManager().clientIdFor('file:///a.tst', 'readonly')).not.toBe(editable);
      expect(new IdManager().clientIdFor('file:///a.tst', 'editable')).toBe(editable);
   });

   it('gives a document the same id in every manager of the window, and other documents other ids', () => {
      const first = new IdManager().clientIdFor('file:///a.tst');

      expect(new IdManager().clientIdFor('file:///a.tst')).toBe(first);
      expect(new IdManager().clientIdFor('file:///b.tst')).not.toBe(first);
      expect(first.startsWith('test-diagram_')).toBe(true);
   });

   it('builds ids a CSS id selector accepts, since GLSP finds the diagram’s element by one', () => {
      const id = new IdManager().clientIdFor('file:///home/user/My Folder/a.tst');

      expect(id).toMatch(/^[A-Za-z][\w-]*$/);
   });
});
