/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Submits that find a document the diagram writes broken keep the model off the client. */

import { type Action, SetDirtyStateAction, SourceModelStorage, UndoAction } from '@eclipse-glsp/server';
import type { AstNode } from '@hydranium/langium';
import { RequestEditsSettledAction, isDocumentSyntaxError } from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/testing';
import { describe, expect, it, vi } from 'vitest';
import {
   type Setup,
   allowExternalSubmits,
   apply,
   applyFailing,
   changeTextBuilt,
   createTask,
   dispatcherOf,
   flushResubmit,
   handlerOf,
   move,
   openDiagram,
   textOf,
   undoOrRedo
} from './uncommitted-edit-harness.js';

/** Break the layout as another client, built: a node position loses its x. */
async function breakLayout(opened: Setup): Promise<void> {
   await changeTextBuilt(opened, opened.layoutUri, text => {
      const broken = text.replace(/node Pay at \d+, /, 'node Pay at , ');
      expect(broken).not.toBe(text);
      return broken;
   });
}

/** Break the layout once the diagram's next write has landed. */
function breakLayoutAfterNextWrite(opened: Setup): void {
   const state = opened.diagram.state;
   const update = state.updateSourceModel.bind(state);
   vi.spyOn(state, 'updateSourceModel').mockImplementationOnce(async (...args) => {
      await update(...args);
      await breakLayout(opened);
   });
}

const MODEL_KINDS = ['setModel', 'updateModel', 'requestBounds'];

function modelsIn(actions: Action[]): string[] {
   return actions.map(action => action.kind).filter(kind => MODEL_KINDS.includes(kind));
}

function dirtyReasonsIn(actions: readonly Action[]): (string | undefined)[] {
   return actions.filter(action => SetDirtyStateAction.is(action)).map(action => action.reason);
}

describe('a submit while the write set is broken', () => {
   it('of a failed operation resync sends the dirty state but no model', async () => {
      const opened = await openDiagram();
      const { diagram } = opened;
      const create = createTask();
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(async () => {
         await breakLayout(opened);
         throw new Error('the handler failed');
      });
      const before = diagram.actions.length;
      await applyFailing(diagram, create);
      await waitFor(() => diagram.actions.slice(before).some(action => SetDirtyStateAction.is(action) && action.reason === 'operation'), {
         message: 'no resync'
      });

      expect(modelsIn(diagram.actions.slice(before))).toEqual([]);
   });

   it('of an operation sends the dirty state but no model', async () => {
      const opened = await openDiagram();
      const { diagram } = opened;
      breakLayoutAfterNextWrite(opened);
      const before = diagram.actions.length;
      await apply(diagram, move(diagram, 'Pay', 50, 110));
      const sent = diagram.actions.slice(before);

      expect({ models: modelsIn(sent), dirty: dirtyReasonsIn(sent) }).toEqual({ models: [], dirty: expect.arrayContaining(['operation']) });
   });

   it('of an operation lets the rebuild send the model once the text is restored as it was before', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      await allowExternalSubmits(diagram);
      const original = textOf(opened, layoutUri);
      breakLayoutAfterNextWrite(opened);
      await apply(diagram, move(diagram, 'Pay', 50, 110));
      await changeTextBuilt(opened, layoutUri, () => original);
      const storage = diagram.sessionContainer.get<SourceModelStorage>(SourceModelStorage) as unknown as {
         captureAndSubmit(rootUri: string, root: AstNode): Promise<Action[]>;
      };
      const captured = vi.spyOn(storage, 'captureAndSubmit');
      flushResubmit(diagram);
      await waitFor(() => captured.mock.results.length > 0, { message: 'the resubmit never captured' });

      expect(modelsIn(await captured.mock.results[0].value)).not.toEqual([]);
   });

   it('of an operation refused for a syntax error lets the rebuild send the model once the text is restored as it was before', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      await allowExternalSubmits(diagram);
      const original = textOf(opened, layoutUri);
      await changeTextBuilt(opened, layoutUri, text => text.replace('node Ship at 660, 200', 'node Ship at , 200'));
      const outcome = await dispatcherOf(diagram)
         .dispatch(move(diagram, 'Pay', 50, 110))
         .then(
            () => undefined,
            (error: unknown) => error
         );
      // A settle waits for any resync the refusal started.
      await dispatcherOf(diagram).dispatch(RequestEditsSettledAction.create());
      await changeTextBuilt(opened, layoutUri, () => original);
      const storage = diagram.sessionContainer.get<SourceModelStorage>(SourceModelStorage) as unknown as {
         captureAndSubmit(rootUri: string, root: AstNode): Promise<Action[]>;
      };
      const captured = vi.spyOn(storage, 'captureAndSubmit');
      flushResubmit(diagram);
      await waitFor(() => captured.mock.results.length > 0, { message: 'the resubmit never captured' });

      expect(isDocumentSyntaxError(outcome)).toBe(true);
      expect(modelsIn(await captured.mock.results[0].value)).not.toEqual([]);
   });

   it('of an undo sends the dirty state but no model', async () => {
      const opened = await openDiagram();
      const { diagram } = opened;
      await apply(diagram, move(diagram, 'Pay', 50, 110));
      breakLayoutAfterNextWrite(opened);
      const before = diagram.actions.length;
      await undoOrRedo(diagram, UndoAction.create());
      const sent = diagram.actions.slice(before);

      expect({ models: modelsIn(sent), dirty: dirtyReasonsIn(sent) }).toEqual({ models: [], dirty: expect.arrayContaining(['undo']) });
   });
});
