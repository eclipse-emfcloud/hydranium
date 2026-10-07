/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import {
   type ActionDispatcher,
   ActionHandlerConstructor,
   type BindingTarget,
   InstanceMultiBinding,
   SaveModelActionHandler
} from '@eclipse-glsp/server';
import { HydraniumGlspServerActionDispatcher } from '../src/dispatcher/server-action-dispatcher.js';
import { AbstractHydraniumGlspDiagramModule } from '../src/launcher/abstract-hydranium-glsp-diagram-module.js';
import { HydraniumGlspRequestSaveModelActionHandler } from '../src/storage/hydranium-glsp-request-save-model-action-handler.js';

/** Exposes what the base registers; the bindings it never reaches throw. */
class ProbeModule extends AbstractHydraniumGlspDiagramModule {
   readonly diagramType = 'probe';

   protected bindSourceModelStorage(): never {
      throw new Error('not reached');
   }
   protected bindModelState(): never {
      throw new Error('not reached');
   }
   protected bindDiagramConfiguration(): never {
      throw new Error('not reached');
   }
   protected bindGModelFactory(): never {
      throw new Error('not reached');
   }

   registeredActionHandlers(): ActionHandlerConstructor[] {
      const binding = new InstanceMultiBinding<ActionHandlerConstructor>(ActionHandlerConstructor);
      this.configureActionHandlers(binding);
      return binding.getAll();
   }

   boundActionDispatcher(): BindingTarget<ActionDispatcher> {
      return this.bindActionDispatcher();
   }
}

describe('AbstractHydraniumGlspDiagramModule action handlers', () => {
   it('answers the Theia client’s save request and keeps GLSP’s save for other clients', () => {
      const handlers = new ProbeModule().registeredActionHandlers();

      expect(handlers).toContain(HydraniumGlspRequestSaveModelActionHandler);
      expect(handlers).toContain(SaveModelActionHandler);
   });
});

describe('AbstractHydraniumGlspDiagramModule action dispatcher', () => {
   it('times every dispatch through HydraniumGlspServerActionDispatcher', () => {
      expect(new ProbeModule().boundActionDispatcher()).toBe(HydraniumGlspServerActionDispatcher);
   });
});
