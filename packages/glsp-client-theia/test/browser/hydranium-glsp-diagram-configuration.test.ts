/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// `@eclipse-glsp/theia-integration` resolves back into `@eclipse-glsp/client`'s
// TypeScript sources through its exports map, which the node test env cannot
// parse. `@eclipse-glsp/client` itself imports fine and is left real, so the
// marker manager under assertion is the shipped class.
//
// The two `connect*` functions are the OBSERVABLE here rather than an
// inconvenience: what this class decides is which factory each one receives,
// and both write into a container whose bindings would otherwise have to be
// resolved to be read back.
const { connectContextMenuMock, connectMarkerManagerMock } = vi.hoisted(() => ({
   connectContextMenuMock: vi.fn(),
   connectMarkerManagerMock: vi.fn()
}));

vi.mock('@eclipse-glsp/theia-integration', () => ({
   GLSPDiagramConfiguration: class GLSPDiagramConfiguration {},
   connectTheiaContextMenuService: connectContextMenuMock,
   connectTheiaMarkerManager: connectMarkerManagerMock
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TheiaContextMenuService, TheiaMarkerManager } from '@eclipse-glsp/theia-integration';
import { Container } from '@theia/core/shared/inversify';
import { NoOpExternalMarkerManager } from '../../src/browser/diagram-only-marker-manager.js';
import { AbstractHydraniumGlspDiagramConfiguration } from '../../src/browser/hydranium-glsp-diagram-configuration.js';

const DIAGRAM_TYPE = 'diagram-one';

/**
 * Stand-ins for the two factories `GLSPDiagramConfiguration` injects. They are
 * asserted by IDENTITY, so what they produce does not matter — what matters is
 * which of them each `connect*` call receives.
 */
const baseMarkerManagerFactory = (): TheiaMarkerManager => new NoOpExternalMarkerManager() as unknown as TheiaMarkerManager;
const baseContextMenuFactory = (): TheiaContextMenuService => ({ id: 'context-menu' }) as unknown as TheiaContextMenuService;

class ConfigurationUnderTest extends AbstractHydraniumGlspDiagramConfiguration {
   override readonly diagramType = DIAGRAM_TYPE;
   protected override readonly theiaMarkerManager = baseMarkerManagerFactory;
   protected override readonly contextMenuServiceFactory = baseContextMenuFactory;

   constructor(propagate?: boolean) {
      super();
      if (propagate !== undefined) {
         this.propagateMarkersToProblemsView = propagate;
      }
   }

   /** Abstract on the base and irrelevant here — this class only wires markers. */
   configureContainer(): void {}

   /** `initializeContainer` is protected; a head only reaches it through the base. */
   run(container: Container): void {
      this.initializeContainer(container);
   }
}

describe('AbstractHydraniumGlspDiagramConfiguration', () => {
   beforeEach(() => {
      connectContextMenuMock.mockClear();
      connectMarkerManagerMock.mockClear();
   });

   it('propagates markers to the Problems view by default', () => {
      // The framework default is the STOCK behaviour, so a graphical-only head
      // that never thinks about this flag keeps its markers in Problems.
      new ConfigurationUnderTest().run(new Container());

      expect(connectMarkerManagerMock).toHaveBeenCalledWith(expect.anything(), baseMarkerManagerFactory, DIAGRAM_TYPE);
   });

   it('hands a non-propagating manager to the marker wiring when suppression is on', () => {
      // A head whose co-resident LSP publishes the same diagnostics would
      // otherwise list every error twice, under two marker owners, with the
      // GLSP copy vanishing when the diagram closes.
      new ConfigurationUnderTest(false).run(new Container());

      const [, factory] = connectMarkerManagerMock.mock.calls[0];
      expect(factory).not.toBe(baseMarkerManagerFactory);
      expect(factory()).toBeInstanceOf(NoOpExternalMarkerManager);
   });

   it('wires the context menu service on both settings', () => {
      // This override does NOT call `super.initializeContainer`; it reproduces
      // the base body. The context-menu wiring is the part of that body with
      // nothing to do with markers, so it is what would silently disappear if
      // the reproduction were trimmed to the flag it exists for.
      new ConfigurationUnderTest(true).run(new Container());
      new ConfigurationUnderTest(false).run(new Container());

      expect(connectContextMenuMock).toHaveBeenCalledTimes(2);
      for (const call of connectContextMenuMock.mock.calls) {
         expect(call[1]).toBe(baseContextMenuFactory);
      }
   });
});
