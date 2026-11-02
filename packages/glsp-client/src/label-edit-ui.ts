/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { GlspEditLabelUI } from '@eclipse-glsp/client';
import { injectable } from 'inversify';

/**
 * Sprotty 1.4 leaves a delayed blur submission alive when its label editor
 * closes. The same input serves the next label, so that callback can submit
 * or close a later edit. Keep the blur timer owned by the visible editor.
 */
@injectable()
export class HydraniumLabelEditUI extends GlspEditLabelUI {
   protected blurTimeout: number | undefined;

   protected override configureAndAdd(element: HTMLInputElement | HTMLTextAreaElement, containerElement: HTMLElement): void {
      // The base installs an anonymous blur listener whose timer cannot be
      // cancelled. Configure the input here so hide can cancel that work.
      element.style.visibility = 'hidden';
      element.style.position = 'absolute';
      element.style.top = '0px';
      element.style.left = '0px';
      const target: HTMLElement = element;
      target.addEventListener('keydown', event => this.hideIfEscapeEvent(event));
      target.addEventListener('keyup', event => this.validateLabelIfContentChange(event, element.value));
      target.addEventListener('blur', () => {
         window.clearTimeout(this.blurTimeout);
         this.blurTimeout = window.setTimeout(() => {
            this.blurTimeout = undefined;
            void this.applyLabelEdit();
         }, 200);
      });
      containerElement.appendChild(element);
   }

   override hide(): void {
      super.hide();
      // Hiding the focused input can itself fire blur, so cancel after it.
      window.clearTimeout(this.blurTimeout);
      this.blurTimeout = undefined;
   }
}
