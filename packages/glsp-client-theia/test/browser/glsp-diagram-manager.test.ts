/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type GLSPDiagramWidget } from '@eclipse-glsp/theia-integration/lib/browser';
import { type GLSPDiagramLanguage } from '@eclipse-glsp/theia-integration/lib/common';
import { type WidgetOpenerOptions } from '@theia/core/lib/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbstractHydraniumGlspDiagramManager } from '../../src/browser/glsp-diagram-manager.js';

/**
 * What the base class received, so the assertion is on the options this override
 * HANDS ON rather than on a return value both branches produce.
 */
let received: Array<WidgetOpenerOptions | undefined>;

// `@eclipse-glsp/theia-integration` is mocked rather than loaded: pre-bundling
// it drags in Theia browser modules that touch DOM globals at import time, so
// this package's dep optimizer deliberately leaves it out and every suite here
// mocks it instead.
//
// The consequence, stated rather than hidden: this suite cannot execute
// upstream's `determineNavigations`, so it does not reproduce the throw itself.
// It pins the CONTRACT the override exists to satisfy — an `undefined`
// `selection` never reaches the base, a real one always does — which is the half
// that can regress here. The throw was confirmed by reading upstream's
// `OptionsWithSelection.is` (`'selection' in options`, true for an explicit
// `undefined`, guarding an `Object.keys` on that value) and observed in a
// running app.
vi.mock('@eclipse-glsp/theia-integration', () => ({
   GLSPDiagramManager: class {
      protected handleNavigations(_widget: unknown, options?: WidgetOpenerOptions): boolean {
         received.push(options);
         return options !== undefined && 'selection' in options;
      }
   }
}));

const LANGUAGE: GLSPDiagramLanguage = {
   diagramType: 'test-diagram',
   label: 'Test Diagram',
   contributionId: 'test-contribution',
   fileExtensions: ['.tst']
};

class TestDiagramManager extends AbstractHydraniumGlspDiagramManager {
   protected readonly diagramLanguage = LANGUAGE;
   protected readonly managerLabel = 'Test Diagram Editor';

   navigate(options?: WidgetOpenerOptions): boolean {
      return this.handleNavigations({} as GLSPDiagramWidget, options);
   }
}

describe('AbstractHydraniumGlspDiagramManager.handleNavigations', () => {
   beforeEach(() => {
      received = [];
   });

   it("drops a present-but-undefined selection, the shape Theia's file picker sends", () => {
      // `QuickFileOpenService.buildOpenerOptions` returns `{ selection: range }`,
      // and `range` is undefined unless the typed query carried a `:line:column`
      // suffix — so this is the ordinary case of opening a diagram by name, not
      // an edge one.
      new TestDiagramManager().navigate({ selection: undefined } as WidgetOpenerOptions);

      expect(received).toHaveLength(1);
      expect(received[0] && 'selection' in received[0]).toBe(false);
   });

   it('passes a real selection through untouched', () => {
      // The half that stops the fix from being "always drop selection", which
      // would satisfy the undefined-selection case while silently breaking
      // every caller that reveals a diagram at a position.
      const selection = { start: { line: 3, character: 7 }, end: { line: 3, character: 7 } };

      const navigated = new TestDiagramManager().navigate({ selection } as WidgetOpenerOptions);

      expect(navigated).toBe(true);
      expect(received[0]).toEqual({ selection });
   });

   it('leaves options that carry no selection key alone', () => {
      new TestDiagramManager().navigate({ mode: 'activate' } as WidgetOpenerOptions);

      expect(received[0]).toEqual({ mode: 'activate' });
   });

   it('leaves absent options absent, rather than substituting an empty object', () => {
      new TestDiagramManager().navigate(undefined);

      expect(received[0]).toBeUndefined();
   });
});
