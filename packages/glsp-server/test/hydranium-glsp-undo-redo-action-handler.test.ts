/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UndoRedoActionHandler } from '@eclipse-glsp/server';

/** The digest of `method`'s source, whitespace-insensitive so a reformat alone does not redden. */
function digestOf(method: (...args: never[]) => unknown): string {
   return createHash('sha256').update(method.toString().replace(/\s+/g, ' ').trim()).digest('hex');
}

describe('upstream undo and redo', () => {
   it('still match the bodies HydraniumGlspUndoRedoActionHandler was lifted from', () => {
      const prototype = UndoRedoActionHandler.prototype as unknown as Record<'undo' | 'redo', (...args: never[]) => unknown>;
      expect(
         { undo: digestOf(prototype.undo), redo: digestOf(prototype.redo) },
         'upstream @eclipse-glsp/server changed UndoRedoActionHandler.undo or redo — re-lift them into ' +
            'HydraniumGlspUndoRedoActionHandler.undoOrRedo and update these digests'
      ).toEqual({
         undo: '403122c9354517463e7fdcf299091be986a795a7ee8b0445666562b6e351b120',
         redo: '2b4c9d72617b780dc563e921aeee673d8f899cb43f6a0436dc52225862fbc55b'
      });
   });
});
