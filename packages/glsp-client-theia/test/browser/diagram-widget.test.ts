/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Two module stand-ins keep this suite in the node environment:
//  - `@hydranium/client-theia/browser` pulls `@theia/output` → DOM globals
//  - `@eclipse-glsp/theia-integration`'s real `GLSPDiagramWidget` extends Theia's
//    `BaseWidget`, which touches `document` at module load
// The overlay's *lifecycle* — when it is created, when it comes down — is what is
// under test. Its DOM construction is not: no vitest environment here provides a
// document, so `createLoadingOverlay` is substituted.
vi.mock('@hydranium/client-theia/lib/browser', () => ({
   ChannelLogger: class ChannelLogger {}
}));
vi.mock('@eclipse-glsp/theia-integration', () => ({
   GLSPDiagramWidget: class GLSPDiagramWidget {
      onAfterAttachCalls = 0;
      initializeDiagramCalls = 0;
      disposeCalls = 0;
      saveable?: { dispose(): void };
      readonly toDispose = {
         pushed: [] as unknown[],
         push(item: unknown): void {
            this.pushed.push(item);
         }
      };
      readonly actionDispatcher = { kind: 'dispatcher' };
      readonly diContainer = { get: (): unknown => ({ kind: 'editor context' }) };
      /** Builds GLSP's own saveable inline, as the real `configure` does. */
      configure(): void {
         this.saveable = { dispose: vi.fn() };
         this.toDispose.push(this.saveable);
      }
      protected onAfterAttach(): void {
         this.onAfterAttachCalls++;
      }
      protected async initializeDiagram(): Promise<void> {
         this.initializeDiagramCalls++;
      }
      dispose(): void {
         this.disposeCalls++;
      }
   }
}));
// The real saveable's module requires GLSP's CommonJS build; its behaviour has
// its own suite. What is under test here is that the widget installs it.
vi.mock('../../src/browser/glsp-saveable', () => ({
   HydraniumGlspSaveable: class HydraniumGlspSaveable {
      constructor(
         readonly actionDispatcher: unknown,
         readonly editorContextService: unknown
      ) {}
      dispose(): void {}
   }
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Message } from '@theia/core/lib/browser';
import { DIAGRAM_LOADING_CLASS, DIAGRAM_LOADING_FAILED_CLASS, HydraniumGlspDiagramWidget } from '../../src/browser/diagram-widget';
import { type DiagramLoadOutcome, HydraniumDiagramLoader } from '../../src/browser/diagram-loader';
import { HydraniumGlspSaveable } from '../../src/browser/glsp-saveable';

/** Records `appendChild` / `remove` without a DOM. */
interface OverlayHost {
   readonly children: FakeElement[];
   appendChild(child: FakeElement): void;
}
/** Enough of an element for the overlay lifecycle: a class list, the label child
 *  `showLoadFailure` looks up, appended children, and removal from the host. */
interface FakeElement {
   className: string;
   readonly classes: Set<string>;
   readonly label: { textContent: string };
   readonly appended: unknown[];
   classList: { add(token: string): void };
   appendChild(child: unknown): void;
   querySelector(selector: string): { textContent: string } | undefined;
   remove(): void;
}

function makeOverlayHost(): OverlayHost {
   const children: FakeElement[] = [];
   return {
      children,
      appendChild(child) {
         children.push(child);
      }
   };
}

/**
 * A loader whose settle is driven by the test. Extends the real
 * {@link HydraniumDiagramLoader} because the widget narrows with `instanceof`, so
 * a duck-typed stand-in would be (correctly) ignored.
 */
class ControllableLoader extends HydraniumDiagramLoader {
   settleNow(outcome: DiagramLoadOutcome): void {
      this.settle(outcome);
   }
}

/**
 * Substitutes the overlay's DOM construction and the container lookup, leaving the
 * production `showLoadingOverlay` / `hideLoadingOverlay` / `onAfterAttach` /
 * `dispose` logic under test verbatim.
 */
class TestableWidget extends HydraniumGlspDiagramWidget {
   readonly overlayHost = makeOverlayHost();
   /** `node` is a public readonly property on Theia's `Widget`, normally assigned
    *  in its constructor; overriding it as a field is how the overlay gets a host
    *  without a DOM. */
   override readonly node = this.overlayHost as unknown as HTMLElement;
   loader?: HydraniumDiagramLoader;
   createdOverlays = 0;

   attach(): void {
      this.onAfterAttach({} as Message);
   }

   currentOverlay(): FakeElement | undefined {
      return this.loadingOverlay as unknown as FakeElement | undefined;
   }

   retry(): void {
      this.retryLoad();
   }

   protected override createRetryButton(): HTMLElement {
      return { kind: 'retry button' } as unknown as HTMLElement;
   }

   protected override get hydraniumDiagramLoader(): HydraniumDiagramLoader | undefined {
      return this.loader;
   }

   protected override createLoadingOverlay(): HTMLElement {
      this.createdOverlays++;
      const classes = new Set([DIAGRAM_LOADING_CLASS]);
      const label = { textContent: this.loadingLabel };
      const appended: unknown[] = [];
      const element: FakeElement = {
         className: DIAGRAM_LOADING_CLASS,
         classes,
         label,
         appended,
         classList: { add: token => classes.add(token) },
         appendChild: child => appended.push(child),
         querySelector: selector => (selector === `.${DIAGRAM_LOADING_CLASS}-label` ? label : undefined),
         remove: () => {
            const index = this.overlayHost.children.indexOf(element);
            if (index >= 0) {
               this.overlayHost.children.splice(index, 1);
            }
         }
      };
      return element as unknown as HTMLElement;
   }
}

/** Let the `onceLoadSettled().then(...)` continuation run. */
const flush = (): Promise<void> => Promise.resolve().then(() => undefined);

describe('HydraniumGlspDiagramWidget', () => {
   let widget: TestableWidget;
   let loader: ControllableLoader;

   beforeEach(() => {
      widget = new TestableWidget();
      loader = new ControllableLoader();
      widget.loader = loader;
   });

   it('replaces GLSP’s saveable with one that stays dirty while a save is pending', () => {
      const base = widget as unknown as { saveable?: { dispose(): void }; toDispose: { pushed: unknown[] } };
      widget.configure({} as never, {} as never);

      const [glspSaveable, installed] = base.toDispose.pushed as [{ dispose: ReturnType<typeof vi.fn> }, unknown];
      expect(widget.saveable).toBeInstanceOf(HydraniumGlspSaveable);
      expect(installed).toBe(widget.saveable);
      // GLSP's own one listens to the dirty state until disposed.
      expect(glspSaveable.dispose).toHaveBeenCalled();
      expect(widget.saveable).toMatchObject({ actionDispatcher: { kind: 'dispatcher' }, editorContextService: { kind: 'editor context' } });
   });

   it('covers the canvas on attach while the load is in flight', () => {
      widget.attach();
      expect(widget.overlayHost.children).toHaveLength(1);
      expect(widget.overlayHost.children[0].className).toBe(DIAGRAM_LOADING_CLASS);
   });

   it('still runs the base attach behaviour', () => {
      widget.attach();
      expect((widget as unknown as { onAfterAttachCalls: number }).onAfterAttachCalls).toBe(1);
   });

   it('removes the overlay once the load succeeds', async () => {
      widget.attach();
      loader.settleNow({ status: 'loaded' });
      await flush();
      expect(widget.overlayHost.children).toHaveLength(0);
      expect(widget.currentOverlay()).toBeUndefined();
   });

   /** The loader's report reaching the dispatcher does not put it on screen:
    *  uncovering the canvas leaves it blank. */
   it('keeps the overlay with the error and a Retry for a reported failure too', async () => {
      widget.attach();
      loader.settleNow({ status: 'failed', error: new Error('connection refused'), surfaced: true });
      await flush();

      expect(widget.overlayHost.children).toHaveLength(1);
      const overlay = widget.overlayHost.children[0];
      expect(overlay.label.textContent).toBe('Diagram failed to load: connection refused');
      expect(overlay.appended).toEqual([{ kind: 'retry button' }]);
   });

   /** A second load in the same container registers the model source's handlers twice. */
   it('asks to be reopened on Retry rather than loading again in place', async () => {
      const requests = vi.fn();
      widget.onDidRequestReopen(requests);
      widget.attach();
      loader.settleNow({ status: 'failed', error: 'boom', surfaced: true });
      await flush();

      widget.retry();

      expect(requests).toHaveBeenCalledTimes(1);
      expect((widget as unknown as { initializeDiagramCalls: number }).initializeDiagramCalls).toBe(0);
   });

   it('ignores Retry unless the load failed', () => {
      const requests = vi.fn();
      widget.onDidRequestReopen(requests);
      widget.attach();
      widget.retry();
      expect(requests).not.toHaveBeenCalled();
   });

   it('keeps the overlay and shows the error when the failure could not be surfaced', async () => {
      // The dead-dispatcher case: no StatusAction landed, so this overlay is the
      // only surface left. Uncovering would leave a blank canvas whose only
      // explanation is a line in the Output channel.
      widget.attach();
      loader.settleNow({ status: 'failed', error: new Error('connection refused'), surfaced: false });
      await flush();

      expect(widget.overlayHost.children).toHaveLength(1);
      const overlay = widget.overlayHost.children[0];
      expect(overlay.classes.has(DIAGRAM_LOADING_FAILED_CLASS)).toBe(true);
      expect(overlay.label.textContent).toBe('Diagram failed to load: connection refused');
   });

   it('reuses the same overlay node when switching to the failure state', async () => {
      // Repurposed in place rather than removed and re-inserted, so there is no
      // flicker between the spinner disappearing and the message appearing.
      widget.attach();
      const before = widget.currentOverlay();
      loader.settleNow({ status: 'failed', error: 'boom', surfaced: false });
      await flush();
      expect(widget.currentOverlay()).toBe(before);
      expect(widget.createdOverlays).toBe(1);
   });

   it('renders a non-Error rejection value in the failure message', async () => {
      widget.attach();
      loader.settleNow({ status: 'failed', error: 'boom', surfaced: false });
      await flush();
      expect(widget.overlayHost.children[0].label.textContent).toBe('Diagram failed to load: boom');
   });

   it('skips the overlay entirely when the load already settled', () => {
      // Re-attaching a loaded diagram (a tab switch): creating and immediately
      // removing an overlay would flash.
      loader.settleNow({ status: 'loaded' });
      widget.attach();
      expect(widget.createdOverlays).toBe(0);
      expect(widget.overlayHost.children).toHaveLength(0);
   });

   it('does not stack overlays across repeated attaches', () => {
      widget.attach();
      widget.attach();
      expect(widget.createdOverlays).toBe(1);
      expect(widget.overlayHost.children).toHaveLength(1);
   });

   it('takes the failure overlay down on dispose too', async () => {
      widget.attach();
      loader.settleNow({ status: 'failed', error: 'boom', surfaced: false });
      await flush();
      widget.dispose();
      expect(widget.overlayHost.children).toHaveLength(0);
      expect(widget.currentOverlay()).toBeUndefined();
   });

   it('takes the overlay down on dispose, so a widget closed mid-load leaks nothing', () => {
      widget.attach();
      widget.dispose();
      expect(widget.overlayHost.children).toHaveLength(0);
      expect(widget.currentOverlay()).toBeUndefined();
      expect((widget as unknown as { disposeCalls: number }).disposeCalls).toBe(1);
   });

   it('shows no overlay when the container binds a plain DiagramLoader', () => {
      // No framework loader means no settle signal; an overlay that never comes
      // down would be worse than none.
      widget.loader = undefined;
      widget.attach();
      expect(widget.createdOverlays).toBe(0);
   });
});
