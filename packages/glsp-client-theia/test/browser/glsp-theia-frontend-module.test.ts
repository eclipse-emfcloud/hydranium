/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Two module stand-ins keep this suite in the node environment:
//  - `@eclipse-glsp/theia-integration` resolves back into `@eclipse-glsp/client`'s
//    TypeScript sources through its exports map, which the node test env cannot parse
//  - `@hydranium/client-theia/browser` pulls `@theia/output` → DOM globals
//
// Standing in for the BASE CLASS is what makes these assertions mean anything
// rather than being convenience. With the real `GLSPTheiaFrontendModule`,
// `super.bindGLSPClientContribution` binds the token itself, so "this override
// bound it" and "the base bound it" would produce the same observable and every
// assertion below would pass whatever the override did.
const { bindLogLevelPreferenceMock, registerDiagramManagerMock, superCalls } = vi.hoisted(() => ({
   bindLogLevelPreferenceMock: vi.fn(),
   registerDiagramManagerMock: vi.fn(),
   superCalls: { initialize: 0, bindGLSPClientContribution: 0, bindDiagramWidgetFactory: 0 }
}));

vi.mock('@hydranium/client-theia/lib/browser', () => ({
   bindLogLevelPreference: bindLogLevelPreferenceMock,
   ChannelLogger: class ChannelLogger {}
}));
vi.mock('@eclipse-glsp/theia-integration', () => ({
   DiagramConfiguration: Symbol('DiagramConfiguration'),
   GLSPClientContribution: Symbol('GLSPClientContribution'),
   GLSPDiagramWidget: class GLSPDiagramWidget {},
   GLSPTheiaFrontendModule: class GLSPTheiaFrontendModule {
      initialize(): void {
         superCalls.initialize++;
      }
      bindGLSPClientContribution(): void {
         superCalls.bindGLSPClientContribution++;
      }
      bindDiagramWidgetFactory(): void {
         superCalls.bindDiagramWidgetFactory++;
      }
   },
   registerDiagramManager: registerDiagramManagerMock
}));

import {
   type DiagramConfiguration,
   DiagramConfiguration as DiagramConfigurationToken,
   type GLSPClientContribution,
   GLSPClientContribution as GLSPClientContributionToken,
   type GLSPDiagramManager,
   GLSPDiagramWidget
} from '@eclipse-glsp/theia-integration';
import { type GLSPDiagramLanguage } from '@eclipse-glsp/theia-integration/lib/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type interfaces } from '@theia/core/shared/inversify';
import { HydraniumGlspDiagramWidget } from '../../src/browser/diagram-widget';
import { AbstractHydraniumGlspTheiaFrontendModule, SkipClientContribution } from '../../src/browser/glsp-theia-frontend-module';
import { type BindRecorder, makeBindRecorder } from '../../src/testing/bind-recorder';

const LANGUAGE: GLSPDiagramLanguage = {
   contributionId: 'lang-one',
   label: 'Language One',
   diagramType: 'diagram-one',
   fileExtensions: ['.one']
};

class ConfigurationOne {}

class ManagerOne {}

class ContributionOne {}

/**
 * The module binds each of these as an opaque constructor token and never
 * resolves one, so what a double needs is a stable identity and a class name.
 * The real classes declare far more members than any assertion here reads, and
 * the cast states that the structure is deliberately absent rather than
 * overlooked.
 */
function asNewable<T>(stub: new () => object): interfaces.Newable<T> {
   return stub as unknown as interfaces.Newable<T>;
}

/** The shape every adopter writes: the three abstract fields and nothing else. */
class ModuleUnderTest extends AbstractHydraniumGlspTheiaFrontendModule {
   readonly diagramLanguage = LANGUAGE;
   protected readonly diagramConfiguration = asNewable<DiagramConfiguration>(ConfigurationOne);
   protected readonly diagramManager = asNewable<GLSPDiagramManager>(ManagerOne);
}

describe('AbstractHydraniumGlspTheiaFrontendModule', () => {
   let recorder: BindRecorder;

   beforeEach(() => {
      recorder = makeBindRecorder();
      bindLogLevelPreferenceMock.mockClear();
      registerDiagramManagerMock.mockClear();
      superCalls.initialize = 0;
      superCalls.bindGLSPClientContribution = 0;
      superCalls.bindDiagramWidgetFactory = 0;
   });

   it("binds the adopter's configuration class to the DiagramConfiguration token", () => {
      new ModuleUnderTest().bindDiagramConfiguration(recorder);

      expect(recorder.find('bind', DiagramConfigurationToken)?.chain).toEqual([`to(<${ConfigurationOne.name}>)`]);
   });

   it("self-binds the adopter's diagram manager as a singleton and registers it", () => {
      new ModuleUnderTest().configureDiagramManager(recorder);

      expect(recorder.find('bind', ManagerOne)?.chain).toEqual(['toSelf()', 'inSingletonScope()']);
      expect(registerDiagramManagerMock).toHaveBeenCalledWith(recorder.bind, ManagerOne, false);
   });

   describe('bindGLSPClientContribution', () => {
      it('defers to the base class when the hook returns undefined', () => {
         new ModuleUnderTest().bindGLSPClientContribution(recorder);

         expect(superCalls.bindGLSPClientContribution).toBe(1);
         expect(recorder.captured).toEqual([]);
      });

      it('binds the returned class as a singleton and aliases the token to it', () => {
         const contribution = asNewable<GLSPClientContribution>(ContributionOne);
         class WithContribution extends ModuleUnderTest {
            protected override bindClientContribution(): interfaces.Newable<GLSPClientContribution> {
               return contribution;
            }
         }

         new WithContribution().bindGLSPClientContribution(recorder);

         expect(recorder.find('bind', contribution)?.chain).toEqual(['toSelf()', 'inSingletonScope()']);
         expect(recorder.find('bind', GLSPClientContributionToken)?.chain).toEqual([`toService(<${ContributionOne.name}>)`]);
         // The base must NOT also run: it would bind a second contribution for
         // one diagram, and a GLSP client contribution starts a server session.
         expect(superCalls.bindGLSPClientContribution).toBe(0);
      });

      it('binds nothing at all for the skip sentinel', () => {
         // A secondary diagram type sharing one GLSP server with a primary whose
         // module already bound the contribution. Falling through to the base
         // here is the failure the sentinel exists to prevent, and it is silent:
         // two contributions means two server sessions for one server.
         class Skipping extends ModuleUnderTest {
            protected override bindClientContribution(): SkipClientContribution {
               return SkipClientContribution;
            }
         }

         new Skipping().bindGLSPClientContribution(recorder);

         expect(recorder.captured).toEqual([]);
         expect(superCalls.bindGLSPClientContribution).toBe(0);
      });
   });

   describe('initialize', () => {
      it('adds no preference binding when the adopter names no preference', () => {
         new ModuleUnderTest().initialize(recorder);

         expect(superCalls.initialize).toBe(1);
         expect(bindLogLevelPreferenceMock).not.toHaveBeenCalled();
      });

      it('binds the log-level preference on top of the base wiring when one is named', () => {
         class WithPreference extends ModuleUnderTest {
            protected override readonly logLevelPreference = 'lang-one.log.level';
         }

         new WithPreference().initialize(recorder);

         expect(superCalls.initialize).toBe(1);
         expect(bindLogLevelPreferenceMock).toHaveBeenCalledWith(recorder.bind, 'lang-one.log.level');
      });
   });

   it('rebinds the widget token to the framework widget on top of the base factory wiring', () => {
      // Both halves matter. Dropping `super` loses the `DiagramWidgetFactory`
      // the base binds, and dropping the rebind silently returns every head to
      // GLSP's widget — a diagram with no loading overlay, which looks like a
      // slow diagram rather than a missing binding.
      new ModuleUnderTest().bindDiagramWidgetFactory(recorder);

      expect(superCalls.bindDiagramWidgetFactory).toBe(1);
      expect(recorder.find('rebind', GLSPDiagramWidget)?.chain).toEqual([`to(<${HydraniumGlspDiagramWidget.name}>)`]);
   });
});
