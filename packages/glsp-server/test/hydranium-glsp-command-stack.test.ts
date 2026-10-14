/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Container } from 'inversify';
import { type Command, DefaultCommandStack, Logger as GlspLogger, ModelState } from '@eclipse-glsp/server';
import type { ServerSharedServices } from '@hydranium/core';
import { makeNoopSharedServices } from '@hydranium/core/testing';
import { HydraniumGlspCommandStack } from '../src/command/hydranium-glsp-command-stack.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';
import { makeNoopGlspLogger } from '../src/testing/make-noop-glsp-logger.js';

const OWN = 'file:///own.a';
const SECONDARY = 'file:///secondary.b';
const FOREIGN = 'file:///foreign.a';

/** A command stack over a store where `opens` are held by client id, and `dirty` are the dirty URIs. */
function makeStack(opens: Record<string, string[]>, dirty: Set<string>, logger = makeNoopGlspLogger()): HydraniumGlspCommandStack {
   const container = new Container();
   container.bind(GlspLogger).toConstantValue(logger);
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

   it('flushes on a failed command and leaves the log to whoever ends the failure', async () => {
      const errors: unknown[] = [];
      const logger = makeNoopGlspLogger();
      logger.error = (...args: unknown[]): void => void errors.push(args);
      const stack = makeStack({ [OWN]: ['diagram-1'] }, new Set(), logger);
      await stack.execute(noopCommand);
      const failure = new Error('step failed');

      await expect(stack.execute({ ...noopCommand, execute: () => Promise.reject(failure) })).rejects.toBe(failure);

      expect(stack.canUndo()).toBe(false);
      expect(errors).toEqual([]);
   });
});

describe('upstream handleError', () => {
   it('still matches the body HydraniumGlspCommandStack was lifted from', () => {
      // Whitespace-insensitive so a reformat alone does not redden.
      const body = DefaultCommandStack.prototype['handleError'].toString().replace(/\s+/g, ' ').trim();
      expect(
         createHash('sha256').update(body).digest('hex'),
         'upstream @eclipse-glsp/server changed DefaultCommandStack.handleError — re-lift the body into ' +
            'HydraniumGlspCommandStack (keeping the flush without the error line) and update this digest'
      ).toBe('9edbf2ea5a8565a8ee15d8ae64a6d873488ba9bf266ac7ad799b6f8d82d9e2eb');
   });
});

describe('upstream execute', () => {
   it('still matches the body HydraniumGlspCommandStack was lifted from', () => {
      // Whitespace-insensitive so a reformat alone does not redden.
      const body = DefaultCommandStack.prototype.execute.toString().replace(/\s+/g, ' ').trim();
      expect(
         createHash('sha256').update(body).digest('hex'),
         'upstream @eclipse-glsp/server changed DefaultCommandStack.execute — re-lift the body into ' +
            'HydraniumGlspCommandStack (keeping the skipped push of a dropped recording command) and update this digest'
      ).toBe('64d5c7e074f0e3f7f791f8f6c769e6108f6f99acef6db95a58d6e36994362355');
   });
});
