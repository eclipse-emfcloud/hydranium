/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Action, ModelState, UndoRedoActionHandler } from '@eclipse-glsp/server';
import { type AstNode } from '@hydranium/langium';
import { inject, injectable } from 'inversify';
import { type AbstractHydraniumGlspState } from '../state/abstract-hydranium-glsp-state.js';

/**
 * GLSP's undo and redo handler inside the state's `runExclusive`. GLSP's
 * command stack moves its position before it replays the entry, so the
 * boundary covers the whole action: taken around the replay alone, an undo
 * arriving while an operation runs would move the position past an entry it
 * then cannot replay.
 */
@injectable()
export class HydraniumGlspUndoRedoActionHandler extends UndoRedoActionHandler {
   @inject(ModelState) protected readonly modelState!: AbstractHydraniumGlspState<AstNode, unknown>;

   override execute(action: Action): Promise<Action[]> {
      return this.modelState.runExclusive(() => super.execute(action));
   }
}
