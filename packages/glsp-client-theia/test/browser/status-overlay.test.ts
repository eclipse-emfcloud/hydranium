/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { StatusAction } from '@eclipse-glsp/client';
import { describe, expect, it, vi } from 'vitest';
import { HydraniumStatusOverlay } from '../../src/browser/status-overlay';

/** An overlay whose element and parent are stand-ins, so no DOM is needed. */
class TestOverlay extends HydraniumStatusOverlay {
   readonly parent = { insertBefore: vi.fn(), firstChild: undefined };
   readonly element = { isConnected: false };

   constructor() {
      super();
      Object.assign(this, { containerElement: this.element });
   }

   protected override getParentContainer(): HTMLElement {
      return this.parent as unknown as HTMLElement;
   }
}

describe('HydraniumStatusOverlay', () => {
   /** Sprotty's first render replaces the base div the element was inserted
    *  into, and a status shown in a detached element is never seen. */
   it('puts a detached element back into the base div before showing a status', () => {
      const overlay = new TestOverlay();
      overlay.handle(StatusAction.create('Initializing...', { severity: 'INFO' }));
      expect(overlay.parent.insertBefore).toHaveBeenCalledWith(overlay.element, undefined);
   });

   it('leaves an element that is on the page where it is', () => {
      const overlay = new TestOverlay();
      overlay.element.isConnected = true;
      overlay.handle(StatusAction.create('Initializing...', { severity: 'INFO' }));
      expect(overlay.parent.insertBefore).not.toHaveBeenCalled();
   });
});
