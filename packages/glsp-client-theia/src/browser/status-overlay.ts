/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type StatusAction, StatusOverlay } from '@eclipse-glsp/client';
import { injectable } from '@theia/core/shared/inversify';

/**
 * GLSP's status overlay, kept on the page.
 *
 * It inserts its element into the diagram's base div when the diagram starts,
 * and sprotty's first render then replaces that div with its own, so the element
 * is left detached and no status it shows is ever seen. This puts the element
 * back into the current base div before it shows anything.
 */
@injectable()
export class HydraniumStatusOverlay extends StatusOverlay {
   override handle(action: StatusAction): void {
      this.reattach();
      super.handle(action);
   }

   override show(...args: Parameters<StatusOverlay['show']>): void {
      super.show(...args);
      this.reattach();
   }

   protected reattach(): void {
      const container = this.containerElement as HTMLElement | undefined;
      if (!container || container.isConnected) {
         return;
      }
      const parent = this.getParentContainer();
      if (parent) {
         this.insertContainerIntoParent(container, parent);
      }
   }
}
