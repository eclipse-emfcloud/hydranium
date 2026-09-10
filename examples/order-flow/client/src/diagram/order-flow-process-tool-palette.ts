/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ToolPalette } from '@eclipse-glsp/client';
import { injectable } from 'inversify';

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
   override editModeChanged(newValue: string, oldValue: string): void {
      super.editModeChanged(newValue, oldValue);
      this.syncToggleVisibility();
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
