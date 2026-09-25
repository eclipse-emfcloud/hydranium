/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Container } from 'inversify';
import { type Command, Logger as GlspLogger, ModelState } from '@eclipse-glsp/server';
import type { ServerSharedServices } from '@hydranium/core';
import { makeNoopSharedServices } from '@hydranium/core/testing';
import { HydraniumGlspCommandStack } from '../src/command/hydranium-glsp-command-stack.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';
import { makeNoopGlspLogger } from '../src/testing/make-noop-glsp-logger.js';

const OWN = 'file:///own.a';
const SECONDARY = 'file:///secondary.b';
const FOREIGN = 'file:///foreign.a';

/** A command stack over a store where `opens` are held by client id, and `dirty` are the dirty URIs. */
function makeStack(opens: Record<string, string[]>, dirty: Set<string>): HydraniumGlspCommandStack {
   const container = new Container();
   container.bind(GlspLogger).toConstantValue(makeNoopGlspLogger());
   container.bind(ModelState).toConstantValue({ clientId: 'diagram-1' } as unknown as ModelState);
   container.bind(HydraniumTypes.SharedCoreServices).toConstantValue(
      makeNoopSharedServices<ServerSharedServices>({
         workspace: {
            TextDocuments: {
               openDocuments: () => Object.entries(opens).map(([uri, clients]) => ({ uri, clients })),
               isDirty: (uri: string) => dirty.has(uri)
            }
         }
      })
   );
   container.bind(HydraniumGlspCommandStack).toSelf();
   return container.get(HydraniumGlspCommandStack);
}

const noopCommand: Command = {
   execute: async () => undefined,
   undo: async () => undefined,
   redo: async () => undefined,
   canUndo: () => true
};

describe('HydraniumGlspCommandStack', () => {
   it('is dirty when any document the diagram has open is, the secondaries included', () => {
      const dirty = new Set<string>();
      const stack = makeStack({ [OWN]: ['diagram-1'], [SECONDARY]: ['diagram-1', 'form'] }, dirty);
      expect(stack.isDirty).toBe(false);

      dirty.add(SECONDARY);

      expect(stack.isDirty).toBe(true);
   });

   it('ignores a dirty document only another client has open', () => {
      const stack = makeStack({ [OWN]: ['diagram-1'], [FOREIGN]: ['form'] }, new Set([FOREIGN]));
      expect(stack.isDirty).toBe(false);
   });

   it('reads the documents, not the commands it holds or the last save', async () => {
      const stack = makeStack({ [OWN]: ['diagram-1'] }, new Set([OWN]));

      await stack.execute(noopCommand);
      stack.saveIsDone();

      expect(stack.isDirty).toBe(true);
      expect(stack.canUndo()).toBe(true);
   });
});
