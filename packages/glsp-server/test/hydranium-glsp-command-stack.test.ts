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
import { type Command, CompoundCommand, DefaultCommandStack, Logger as GlspLogger, ModelState } from '@eclipse-glsp/server';
import { ConflictError, DocumentSyntaxError, asModelVersion } from '@hydranium/protocol';
import type { ServerSharedServices } from '@hydranium/core';
import { makeNoopSharedServices } from '@hydranium/core/testing';
import { DiagramTextUnreadableError, DiagramWriteRanOutError } from '../src/command/diagram-edit-dropped-error.js';
import { HydraniumGlspCommandStack } from '../src/command/hydranium-glsp-command-stack.js';
import { HydraniumGlspOperationCommand } from '../src/command/hydranium-glsp-operation-command.js';
import { HydraniumGlspRecordingCommand } from '../src/command/hydranium-glsp-recording-command.js';
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

/** An operation command whose undo and redo do what `fail` says, without the state an operation needs. */
function operationFailingWith(fail: () => Promise<void>): HydraniumGlspOperationCommand {
   const command = Object.create(HydraniumGlspOperationCommand.prototype) as HydraniumGlspOperationCommand;
   Object.assign(command, { execute: async () => undefined, undo: fail, redo: fail, canUndo: () => true });
   return command;
}

const refused = (): Promise<void> => Promise.reject(new DocumentSyntaxError(OWN));
const conflicted = (): Promise<void> => Promise.reject(new ConflictError(OWN, asModelVersion(1), 2));
const ranOut = (): DiagramWriteRanOutError => new DiagramWriteRanOutError('ran out', new ConflictError(OWN, asModelVersion(1), 2));
const unreadable = (): DiagramTextUnreadableError =>
   new DiagramTextUnreadableError('unreadable', new ConflictError(OWN, asModelVersion(1), 2));

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

   it.each([
      ['a syntax error', (): unknown => new DocumentSyntaxError(OWN)],
      ['a conflict', (): unknown => new ConflictError(OWN, asModelVersion(1), 2)],
      ['its writes running out', ranOut],
      ['the text not being readable', unreadable]
   ])(
      'keeps the history when a recording command executed on its own is refused for %s, as its operation rolled it back',
      async (_why, make) => {
         const stack = makeStack({}, new Set());
         await stack.execute(noopCommand);
         const refusal = make();
         const command = Object.create(HydraniumGlspRecordingCommand.prototype) as HydraniumGlspRecordingCommand<object>;
         Object.assign(command, { execute: () => Promise.reject(refusal), undo: async () => undefined, canUndo: () => true });

         await expect(stack.execute(command)).rejects.toBe(refusal);

         expect({ undo: stack.canUndo(), redo: stack.canRedo(), top: stack['top'] }).toEqual({ undo: true, redo: false, top: 0 });
      }
   );

   it('flushes the history when a compound executed on its own has a recording command whose writes ran out, as for any refusal of a compound', async () => {
      // Its other children wrote, so nothing is left as it was.
      const stack = makeStack({}, new Set());
      await stack.execute(noopCommand);
      const command = Object.create(HydraniumGlspRecordingCommand.prototype) as HydraniumGlspRecordingCommand<object>;
      Object.assign(command, { execute: () => Promise.reject(ranOut()), undo: async () => undefined, canUndo: () => true });

      await expect(stack.execute(new CompoundCommand([noopCommand, command]))).rejects.toThrow();

      expect({ undo: stack.canUndo(), redo: stack.canRedo() }).toEqual({ undo: false, redo: false });
   });
});

describe('HydraniumGlspCommandStack after a refused undo or redo', () => {
   it('keeps the history and its place when an operation’s undo is refused for a syntax error', async () => {
      const stack = makeStack({}, new Set());
      await stack.execute(noopCommand);
      await stack.execute(operationFailingWith(refused));

      await expect(stack.undo()).rejects.toBeInstanceOf(DocumentSyntaxError);

      expect({ undo: stack.canUndo(), redo: stack.canRedo(), top: stack['top'] }).toEqual({ undo: true, redo: false, top: 1 });
   });

   it('keeps the history and its place when an operation’s redo is refused for a syntax error', async () => {
      const stack = makeStack({}, new Set());
      let fail = false;
      await stack.execute(noopCommand);
      await stack.execute(operationFailingWith(() => (fail ? refused() : Promise.resolve())));
      await stack.undo();
      fail = true;

      await expect(stack.redo()).rejects.toBeInstanceOf(DocumentSyntaxError);

      expect({ undo: stack.canUndo(), redo: stack.canRedo(), top: stack['top'] }).toEqual({ undo: true, redo: true, top: 0 });
   });

   it('keeps the history when a recording command executed on its own is refused for a syntax error, as its operation is', async () => {
      const stack = makeStack({}, new Set());
      const command = Object.create(HydraniumGlspRecordingCommand.prototype) as HydraniumGlspRecordingCommand<object>;
      Object.assign(command, { execute: async () => undefined, undo: refused, canUndo: () => true });
      await stack.execute(command);

      await expect(stack.undo()).rejects.toBeInstanceOf(DocumentSyntaxError);

      expect(stack.canUndo()).toBe(true);
   });

   it('keeps the history when a recording command executed on its own is refused for a conflict, as its operation is', async () => {
      const stack = makeStack({}, new Set());
      const command = Object.create(HydraniumGlspRecordingCommand.prototype) as HydraniumGlspRecordingCommand<object>;
      const conflicting = (): Promise<void> => Promise.reject(new ConflictError(OWN, asModelVersion(1), 2));
      Object.assign(command, { execute: async () => undefined, undo: conflicting, canUndo: () => true });
      await stack.execute(command);

      await expect(stack.undo()).rejects.toBeInstanceOf(ConflictError);

      expect(stack.canUndo()).toBe(true);
   });

   it('keeps the history and its place when an operation’s undo is refused for a conflict', async () => {
      const stack = makeStack({}, new Set());
      await stack.execute(noopCommand);
      await stack.execute(operationFailingWith(conflicted));

      await expect(stack.undo()).rejects.toBeInstanceOf(ConflictError);

      expect({ undo: stack.canUndo(), redo: stack.canRedo(), top: stack['top'] }).toEqual({ undo: true, redo: false, top: 1 });
   });

   it.each([
      ['its writes ran out', ranOut],
      ['the text cannot be read', unreadable]
   ])('keeps the history and its place when an operation’s undo is refused because %s', async (_why, make) => {
      const refusal = make();
      const stack = makeStack({}, new Set());
      await stack.execute(noopCommand);
      await stack.execute(operationFailingWith(() => Promise.reject(refusal)));

      await expect(stack.undo()).rejects.toBe(refusal);

      expect({ undo: stack.canUndo(), redo: stack.canRedo(), top: stack['top'] }).toEqual({ undo: true, redo: false, top: 1 });
   });

   it.each([
      ['its writes ran out', ranOut],
      ['the text cannot be read', unreadable]
   ])('flushes when a compound is refused because %s, and fails as a plain error carrying the refusal', async (_why, make) => {
      const refusal = make();
      const stack = makeStack({}, new Set());
      await stack.execute(new CompoundCommand([noopCommand, operationFailingWith(() => Promise.reject(refusal))]));

      const failure = await stack.undo().then(
         () => undefined,
         (error: unknown) => error
      );

      expect({
         refusal: failure === refusal,
         cause: failure instanceof Error && failure.cause === refusal,
         tellsTheRefusal: failure instanceof Error && failure.message.includes(refusal.message),
         canUndo: stack.canUndo()
      }).toEqual({ refusal: false, cause: true, tellsTheRefusal: true, canUndo: false });
   });

   it('flushes when a compound is refused for a conflict, and fails as a plain error carrying the refusal', async () => {
      const stack = makeStack({}, new Set());
      await stack.execute(new CompoundCommand([noopCommand, operationFailingWith(conflicted)]));

      const failure = await stack.undo().then(
         () => undefined,
         (error: unknown) => error
      );

      expect({
         refusal: failure instanceof ConflictError,
         cause: failure instanceof Error && failure.cause instanceof ConflictError,
         canUndo: stack.canUndo()
      }).toEqual({ refusal: false, cause: true, canUndo: false });
   });

   it('flushes when a compound is refused for a syntax error, and fails as a plain error carrying the refusal', async () => {
      // Its children's own compensation may have failed, so the refusal no longer says nothing changed.
      const stack = makeStack({}, new Set());
      await stack.execute(new CompoundCommand([noopCommand, operationFailingWith(refused)]));

      const failure = await stack.undo().then(
         () => undefined,
         (error: unknown) => error
      );

      expect({
         refusal: failure instanceof DocumentSyntaxError,
         cause: failure instanceof Error && failure.cause instanceof DocumentSyntaxError,
         tellsTheRefusal: failure instanceof Error && failure.message.includes(new DocumentSyntaxError(OWN).message),
         canUndo: stack.canUndo()
      }).toEqual({ refusal: false, cause: true, tellsTheRefusal: true, canUndo: false });
   });

   it('flushes when a command that is no operation is refused for a syntax error, and fails as a plain error carrying the refusal', async () => {
      const stack = makeStack({}, new Set());
      await stack.execute({ ...noopCommand, undo: refused });

      const failure = await stack.undo().then(
         () => undefined,
         (error: unknown) => error
      );

      expect({
         refusal: failure instanceof DocumentSyntaxError,
         cause: failure instanceof Error && failure.cause instanceof DocumentSyntaxError,
         canUndo: stack.canUndo()
      }).toEqual({ refusal: false, cause: true, canUndo: false });
   });

   it('flushes when an operation’s undo fails otherwise', async () => {
      const stack = makeStack({}, new Set());
      await stack.execute(operationFailingWith(() => Promise.reject(new Error('undo failed'))));

      await expect(stack.undo()).rejects.toThrow('undo failed');

      expect(stack.canUndo()).toBe(false);
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

describe('upstream undo and redo', () => {
   it.each([
      ['undo', 'eb967c5f68398abda1b165582135f590bf417933fb5f941da79c05310f90988a'],
      ['redo', '0acc4dc9848f2080c63906e2092d436fa870ce3e7c12fb9b5a9489d950d9c5d9']
   ] as const)('%s still matches the body HydraniumGlspCommandStack was lifted from', (name, digest) => {
      // Whitespace-insensitive so a reformat alone does not redden.
      const body = DefaultCommandStack.prototype[name].toString().replace(/\s+/g, ' ').trim();
      expect(
         createHash('sha256').update(body).digest('hex'),
         `upstream @eclipse-glsp/server changed DefaultCommandStack.${name} — re-lift the body into ` +
            'HydraniumGlspCommandStack (keeping the history after a refusal that left nothing behind) and update this digest'
      ).toBe(digest);
   });
});
