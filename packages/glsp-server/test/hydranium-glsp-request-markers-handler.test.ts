/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Marker, MarkersReason, ModelState, ModelValidator, RequestMarkersAction, SetMarkersAction } from '@eclipse-glsp/server';
import 'reflect-metadata';
import { Container } from 'inversify';
import { describe, expect, it } from 'vitest';
import { HydraniumGlspRequestMarkersHandler } from '../src/validation/hydranium-glsp-request-markers-handler.js';

/** A handler whose validator answers each reason with one marker named after it. */
function createHandler(): HydraniumGlspRequestMarkersHandler {
   const root = { id: 'root' };
   const container = new Container();
   container.bind(ModelState).toConstantValue({ root, index: { getAll: () => [root] } });
   container.bind(ModelValidator).toConstantValue({
      validate: (_elements: unknown, reason?: string): Marker[] => [
         { elementId: 'root', kind: 'error', label: reason ?? '', description: reason ?? '' }
      ]
   });
   container.bind(HydraniumGlspRequestMarkersHandler).toSelf();
   return container.get(HydraniumGlspRequestMarkersHandler);
}

/** Each sent markers set, by its reason and the reasons its markers were validated for. */
function sent(actions: readonly unknown[]): { reason?: string; validatedFor: string[] }[] {
   return actions
      .filter(SetMarkersAction.is)
      .map(action => ({ reason: action.reason, validatedFor: action.markers.map(marker => marker.label) }));
}

describe('HydraniumGlspRequestMarkersHandler', () => {
   it("answers a batch request as GLSP's handler does, then sends the live set", async () => {
      const actions = await createHandler().execute(RequestMarkersAction.create([], { reason: MarkersReason.BATCH }));

      expect(sent(actions)).toEqual([
         { reason: MarkersReason.BATCH, validatedFor: [MarkersReason.BATCH] },
         { reason: MarkersReason.LIVE, validatedFor: [MarkersReason.LIVE] }
      ]);
   });

   it('treats a request without a reason as batch, as the keyboard palette sends it', async () => {
      const actions = await createHandler().execute(RequestMarkersAction.create([]));

      expect(sent(actions).map(set => set.reason)).toEqual([MarkersReason.BATCH, MarkersReason.LIVE]);
   });

   // GLSP's handler validates for the requested reason but sends the set
   // under its default, batch.
   it('answers a request for another reason under that reason, adding nothing', async () => {
      const actions = await createHandler().execute(RequestMarkersAction.create([], { reason: MarkersReason.LIVE }));

      expect(sent(actions)).toEqual([{ reason: MarkersReason.LIVE, validatedFor: [MarkersReason.LIVE] }]);
   });
});
