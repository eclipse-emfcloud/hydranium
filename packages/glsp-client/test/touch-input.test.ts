/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableTouchDragging } from '../src/touch-input';

/** What a re-emitted mouse event was built from. */
interface EmittedMouseEvent {
   readonly type: string;
   readonly init: MouseEventInit;
}

/** An element that records its listeners and lets a test fire one. */
interface ElementDouble {
   readonly listeners: Map<string, (event: PointerEvent) => void>;
   readonly removed: string[];
   readonly captured: number[];
   addEventListener(type: string, listener: (event: PointerEvent) => void): void;
   removeEventListener(type: string, listener: (event: PointerEvent) => void): void;
   setPointerCapture(pointerId: number): void;
   fire(type: string, event: Partial<PointerEvent>): void;
}

function makeElement(): ElementDouble {
   const listeners = new Map<string, (event: PointerEvent) => void>();
   const removed: string[] = [];
   const captured: number[] = [];
   return {
      listeners,
      removed,
      captured,
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type, listener) => {
         if (listeners.get(type) === listener) {
            removed.push(type);
         }
      },
      setPointerCapture: pointerId => captured.push(pointerId),
      fire: (type, event) =>
         listeners.get(type)?.({
            pointerType: 'touch',
            pointerId: 1,
            clientX: 10,
            clientY: 20,
            preventDefault: () => undefined,
            ...event
         } as PointerEvent)
   };
}

/** Stands in for the DOM's `Element`, so a press target can pass an `instanceof` check. */
class ElementStandIn {
   closest(_selector: string): unknown {
      return null;
   }
}

describe('enableTouchDragging', () => {
   let mount: ElementDouble;
   /** The events the element under the finger received, in order. */
   let received: EmittedMouseEvent[];

   beforeEach(() => {
      mount = makeElement();
      received = [];
      vi.stubGlobal(
         'MouseEvent',
         class {
            constructor(
               readonly type: string,
               readonly init: MouseEventInit
            ) {}
         }
      );
      vi.stubGlobal('document', { elementFromPoint: () => ({ dispatchEvent: (event: EmittedMouseEvent) => received.push(event) }) });
      vi.stubGlobal('window', {});
      vi.stubGlobal('Element', ElementStandIn);
   });

   afterEach(() => {
      vi.unstubAllGlobals();
   });

   it('re-emits a touch press as a mouse move and then a mouse down on the element under the finger', () => {
      enableTouchDragging(mount as unknown as HTMLElement);
      mount.fire('pointerdown', { clientX: 10, clientY: 20 });
      expect(received.map(event => event.type)).toEqual(['mousemove', 'mousedown']);
      expect(received[1].init).toMatchObject({ clientX: 10, clientY: 20, button: 0, buttons: 1, bubbles: true });
      expect(mount.captured).toEqual([1]);
   });

   it('carries the moves and the release of a touch drag to the pressed element', () => {
      enableTouchDragging(mount as unknown as HTMLElement);
      mount.fire('pointerdown', {});
      mount.fire('pointermove', { clientX: 30, clientY: 40 });
      mount.fire('pointerup', { clientX: 30, clientY: 40 });
      expect(received.slice(2).map(event => [event.type, event.init.buttons])).toEqual([
         ['mousemove', 1],
         ['mouseup', 0]
      ]);
   });

   it('releases on a cancelled pointer, so the next touch does not resume the drag', () => {
      enableTouchDragging(mount as unknown as HTMLElement);
      mount.fire('pointerdown', {});
      mount.fire('pointercancel', {});
      mount.fire('pointermove', {});
      expect(received.map(event => event.type)).toEqual(['mousemove', 'mousedown', 'mouseup']);
   });

   it('ignores a second finger until the one that started the drag lifts', () => {
      enableTouchDragging(mount as unknown as HTMLElement);
      mount.fire('pointerdown', { pointerId: 1 });
      mount.fire('pointerdown', { pointerId: 2 });
      mount.fire('pointermove', { pointerId: 2 });
      mount.fire('pointerup', { pointerId: 2 });
      mount.fire('pointermove', { pointerId: 1 });
      mount.fire('pointerup', { pointerId: 1 });
      expect(received.map(event => event.type)).toEqual(['mousemove', 'mousedown', 'mousemove', 'mouseup']);
      expect(mount.captured).toEqual([1]);
   });

   it('cancels a touch press, or the browser sends a tap its own mouse events too and the canvas hears it twice', () => {
      enableTouchDragging(mount as unknown as HTMLElement);
      const preventDefault = vi.fn();
      mount.fire('pointerdown', { preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
   });

   it('leaves a press on a text field alone, so the browser still focuses it and places the caret', () => {
      enableTouchDragging(mount as unknown as HTMLElement);
      const preventDefault = vi.fn();
      const field = Object.assign(new ElementStandIn(), { closest: (selector: string) => (selector.includes('input') ? field : null) });
      mount.fire('pointerdown', { preventDefault, target: field as unknown as EventTarget });
      expect(preventDefault).not.toHaveBeenCalled();
      expect(received).toEqual([]);
      expect(mount.captured).toEqual([]);
   });

   it('leaves a mouse or pen pointer alone, since the canvas already hears those', () => {
      enableTouchDragging(mount as unknown as HTMLElement);
      const preventDefault = vi.fn();
      mount.fire('pointerdown', { pointerType: 'mouse', preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
      mount.fire('pointermove', { pointerType: 'pen' });
      mount.fire('pointerup', { pointerType: 'mouse' });
      expect(received).toEqual([]);
      expect(mount.captured).toEqual([]);
   });

   it('removes every listener it added when disposed', () => {
      enableTouchDragging(mount as unknown as HTMLElement).dispose();
      expect(mount.removed.sort()).toEqual(['pointercancel', 'pointerdown', 'pointermove', 'pointerup']);
   });
});
