/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `onUpdate` seam of {@link makeStubAstDocumentManager}, and the trap it
 * fences.
 *
 * Before this existed the stub took a listener, discarded it, and returned a
 * live `Disposable` — so a subscription made through it could never fire. That
 * is not a bug in isolation; it becomes one the moment someone writes the
 * idiom `onUpdate(uri, …); await tick(); expect(events).toHaveLength(0)`, which
 * a listener wired to nothing satisfies unconditionally and which therefore
 * reads as coverage of a suppression that was never exercised.
 *
 * Hence the pair of assertions here: the event has to be DRIVABLE, and the
 * number of subscribers has to be READABLE, so a negative assertion can first
 * show there was something to suppress.
 */

import { describe, expect, it } from 'vitest';
import type { TransferDiagnostic } from '@hydranium/protocol';
import type { AstNode } from '@hydranium/langium';
import type { AstDocumentUpdatedEvent } from '../../src/documents/ast-document-manager.js';
import { makeTestServices } from '../../src/testing/make-test-services.js';

const URI_ONE = 'file:///a.x';
const URI_TWO = 'file:///b.x';

/** An update event with the minimum a subscriber reads. */
function event(uri: string, sourceClientId: string): AstDocumentUpdatedEvent<AstNode, TransferDiagnostic> {
   return {
      document: { uri, version: 1, root: { $type: 'TypeOne' } as AstNode, diagnostics: [] },
      sourceClientId,
      reason: 'changed'
   };
}

describe('StubAstDocumentManager.onUpdate', () => {
   it('delivers a driven event to the subscriber for that URI only', () => {
      const manager = makeTestServices().astDocumentManager;
      const onOne: string[] = [];
      const onTwo: string[] = [];
      manager.onUpdate(URI_ONE, update => onOne.push(update.sourceClientId));
      manager.onUpdate(URI_TWO, update => onTwo.push(update.sourceClientId));

      const delivered = manager.emitUpdate(URI_ONE, event(URI_ONE, 'client-a'));

      expect(delivered).toBe(1);
      expect(onOne).toEqual(['client-a']);
      // Per-URI, like the real manager's canonical-URI filter — a stub that
      // fanned every event to every subscriber would make a "my document only"
      // assertion pass for the wrong reason.
      expect(onTwo).toEqual([]);
   });

   it('reports the subscriber count, so an empty event list can be told from an absent subscription', () => {
      const manager = makeTestServices().astDocumentManager;

      expect(manager.updateSubscriptions()).toBe(0);
      const first = manager.onUpdate(URI_ONE, () => undefined);
      manager.onUpdate(URI_ONE, () => undefined);
      manager.onUpdate(URI_TWO, () => undefined);

      expect(manager.updateSubscriptions(URI_ONE)).toBe(2);
      expect(manager.updateSubscriptions(URI_TWO)).toBe(1);
      expect(manager.updateSubscriptions()).toBe(3);

      first.dispose();
      expect(manager.updateSubscriptions(URI_ONE)).toBe(1);
      expect(manager.updateSubscriptions()).toBe(2);
   });

   it('stops delivering to a disposed subscriber', () => {
      const manager = makeTestServices().astDocumentManager;
      const seen: string[] = [];
      const subscription = manager.onUpdate(URI_ONE, update => seen.push(update.sourceClientId));

      manager.emitUpdate(URI_ONE, event(URI_ONE, 'before'));
      subscription.dispose();
      manager.emitUpdate(URI_ONE, event(URI_ONE, 'after'));

      // Asserting the 'before' arrival too: a `Disposable` that never wired
      // anything up also produces `['']`-shaped emptiness after dispose, and
      // that is exactly the state this fence replaced.
      expect(seen).toEqual(['before']);
      expect(manager.updateSubscriptions(URI_ONE)).toBe(0);
   });

   it('reports zero delivered when nothing subscribed, rather than silently succeeding', () => {
      const manager = makeTestServices().astDocumentManager;

      // The signal a negative assertion needs: `0` here means the test never
      // established the subscription it thinks it is testing the suppression of.
      expect(manager.emitUpdate(URI_ONE, event(URI_ONE, 'nobody'))).toBe(0);
   });

   it('never fires by itself — an update through the manager emits nothing', async () => {
      const manager = makeTestServices().astDocumentManager;
      const seen: string[] = [];
      manager.onUpdate(URI_ONE, update => seen.push(update.sourceClientId));

      await manager.open({ uri: URI_ONE, clientId: 'client-a' });
      await manager.update(URI_ONE, 'changed', 'client-a');

      // The deliberate half of the design: the real event comes from a
      // `Validated` build phase, and the stub tree runs none — so wiring the
      // stub to fire here would assert a phase semantics it does not have, and
      // would move the pass reason of every existing suite on this tree.
      expect(seen).toEqual([]);
      // ...but the subscription is real, which is what makes the emptiness above
      // a statement about the stub rather than about a dropped listener.
      expect(manager.updateSubscriptions(URI_ONE)).toBe(1);
   });
});
