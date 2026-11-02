/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { GlspEditLabelUI } from '@eclipse-glsp/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HydraniumLabelEditUI } from '../src/label-edit-ui';

class TestableLabelEditUI extends HydraniumLabelEditUI {
   applications = 0;

   configure(input: HTMLInputElement): void {
      this.configureAndAdd(input, { appendChild: () => undefined } as unknown as HTMLElement);
   }

   protected override async applyLabelEdit(): Promise<void> {
      this.applications++;
   }
}

function makeInput(): HTMLInputElement {
   return Object.assign(new EventTarget(), { style: {} }) as HTMLInputElement;
}

describe('HydraniumLabelEditUI', () => {
   beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal('window', globalThis);
   });

   afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.useRealTimers();
   });

   it('applies the current label after blur', async () => {
      const ui = new TestableLabelEditUI();
      const input = makeInput();
      ui.configure(input);
      input.dispatchEvent(new Event('blur'));
      expect(ui.applications).toBe(0);
      await vi.runAllTimersAsync();
      expect(ui.applications).toBe(1);
   });

   it('cancels a blur queued by hiding the previous label editor', async () => {
      const ui = new TestableLabelEditUI();
      const input = makeInput();
      ui.configure(input);
      vi.spyOn(GlspEditLabelUI.prototype, 'hide').mockImplementation(() => {
         input.dispatchEvent(new Event('blur'));
      });
      ui.hide();
      await vi.runAllTimersAsync();
      expect(ui.applications).toBe(0);
      input.dispatchEvent(new Event('blur'));
      await vi.runAllTimersAsync();
      expect(ui.applications).toBe(1);
   });
});
