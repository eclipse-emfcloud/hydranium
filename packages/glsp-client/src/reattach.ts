/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Puts a UI extension's element back into the diagram's base div. sprotty's
 * first render replaces that div, so an element inserted before it is left
 * detached. Takes the extension's own lookups, which are protected.
 */
export function reattachUIExtension(
   container: HTMLElement | undefined,
   parentContainer: () => HTMLElement | null | undefined,
   insert: (container: HTMLElement, parent: HTMLElement) => void
): void {
   if (!container || container.isConnected) {
      return;
   }
   const parent = parentContainer();
   if (parent) {
      insert(container, parent);
   }
}
