/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ToolPalette, createIcon, type GModelRoot } from '@eclipse-glsp/client';
import { inject, injectable } from 'inversify';
import { PALETTE } from './order-flow-process-edit-messages';
import { OrderFlowProcessEdit, OpenProcessEditAction } from './order-flow-process-edit';

/**
 * The tool palette, with its collapse toggle withdrawn alongside it.
 *
 * **Upstream hides the palette on a read-only canvas and leaves the toggle
 * standing**, which is a defect rather than a decision, and one every host of
 * this diagram inherits: a Hydranium head flips the canvas READONLY whenever its
 * document stops parsing, so the reader is left with a control that expands and
 * collapses nothing.
 *
 * The cause is a DOM one and not a state one — `ToolPalette` genuinely knows it
 * is read-only. `editModeChanged` hides the extension by dispatching
 * `SetUIExtensionVisibilityAction` for its own id, which reaches the palette's
 * `containerElement`; but `addMinimizePaletteButton` inserts the toggle into the
 * diagram's BASE div, as the palette's sibling rather than its child, so nothing
 * about hiding the palette reaches it. Measured on 0.56: the palette's box goes
 * to 0×0 with `offsetParent` null while the toggle keeps its 20×23.
 *
 * **A stylesheet rule cannot express this**, which is why it is a subclass. The
 * toggle is inserted at `baseDiv.firstChild` and the palette is appended after
 * it, so the toggle PRECEDES the element whose state it would have to follow, and
 * CSS has no preceding-sibling selector; `:has()` on the base div would work but
 * would key an example's stylesheet to the `hidden` class name upstream happens
 * to use for extension visibility.
 *
 * Applied from two places because either can be the last to run: the mode can
 * change while the palette is up, and the palette rebuilds its toggle from
 * scratch on a catalogue update — which would otherwise restore a toggle for a
 * palette that is still hidden.
 */
@injectable()
export class OrderFlowProcessToolPalette extends ToolPalette {
   @inject(OrderFlowProcessEdit) protected readonly processEdit!: OrderFlowProcessEdit;
   protected editButton?: HTMLButtonElement;

   protected override createHeaderTools(): HTMLElement {
      const tools = super.createHeaderTools();
      const button = document.createElement('button');
      button.type = 'button';
      button.title = this.processEdit.text(PALETTE);
      button.setAttribute('aria-label', button.title);
      button.append(createIcon('edit'));
      button.onclick = () => {
         const element = this.processEdit.editableSelection();
         if (element) {
            void this.actionDispatcher.dispatch(OpenProcessEditAction.create(element.id));
         }
      };
      this.editButton = button;
      this.updateEditButton();
      tools.append(button);
      return tools;
   }

   protected override onBeforeShow(container: HTMLElement, root: Readonly<GModelRoot>): void {
      super.onBeforeShow(container, root);
      this.toDisposeOnHide.push(this.editorContext.onSelectionChanged(() => this.updateEditButton()));
      this.updateEditButton();
   }

   protected updateEditButton(): void {
      if (this.editButton) {
         this.editButton.disabled = !this.processEdit.editableSelection();
      }
   }

   override editModeChanged(newValue: string, oldValue: string): void {
      super.editModeChanged(newValue, oldValue);
      this.syncToggleVisibility();
      this.updateEditButton();
   }

   /**
    * Give focus back only when it is inside the palette.
    *
    * sprotty records `document.activeElement` when the palette shows and
    * focuses it again when it hides. The palette hides when the canvas turns
    * read-only, which happens while the reader is typing elsewhere, and
    * restoring then moves the caret into whatever editor had focus when the
    * page first showed the palette.
    */
   protected override restoreFocus(): void {
      if (this.containerElement?.contains(document.activeElement)) {
         super.restoreFocus();
      }
   }

   protected override addMinimizePaletteButton(): void {
      super.addMinimizePaletteButton();
      this.syncToggleVisibility();
   }

   /**
    * Match the toggle's visibility to the palette's.
    *
    * `display` rather than the `hidden` class the extension machinery uses: that
    * class is owned by `AbstractUIExtension`, which would remove it again the
    * next time it shows the palette — and it is not the toggle's extension, so
    * nothing else maintains it here.
    */
   protected syncToggleVisibility(): void {
      if (this.toggleButton) {
         this.toggleButton.style.display = this.editorContext.isReadonly ? 'none' : '';
      }
   }
}
