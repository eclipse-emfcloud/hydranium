/********************************************************************************
 * Copyright (c) 2026 CrossBreeze.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Which `reason` values a `TransferUpdatedEvent` can actually carry, measured
 * against a real `DocumentBuilder` over real files.
 *
 * The reason comes from the builder's last update request: `'changed'` if the
 * URI was in the changed list, `'rebuilt'` otherwise. The event is emitted from
 * a document-phase listener at `Validated`, and a stub builder would let a test
 * fire that listener for any document at all — including one the real builder
 * would already have dropped. So each branch's reachability is only observable
 * against the real thing.
 *
 * A deleted URI is the case that has no reason at all, and this file is where
 * that is measured: the union offers none because the event cannot reach a
 * deleted document, which is why deletion travels on its own notification.
 *
 * The documents must exist ON DISK: `DocumentBuilder.update` re-reads a changed
 * URI through the document factory, so an in-memory `fromString` document makes
 * the whole probe throw `ENOENT` before any event can be emitted.
 */

import { URI } from '@hydranium/langium';
import { afterEach, describe, expect, it } from 'vitest';
import { makeScratchWorkspaceHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const PRIMARY = 'reason-primary.domain';
const SECONDARY = 'reason-secondary.domain';

const PRIMARY_SOURCE = `entity ReasonOrder {
   status : string
}
`;

const SECONDARY_SOURCE = `entity ReasonCustomer {
   name : string
}
`;

let scratch: ScratchOrderFlowHarness | undefined;

afterEach(() => {
   scratch?.workspace.dispose();
   scratch = undefined;
});

/** A built workspace plus every reason delivered for the primary document. */
async function buildFixture(): Promise<{
   harness: ScratchOrderFlowHarness['harness'];
   primaryUri: URI;
   secondaryUri: URI;
   reasons: string[];
}> {
   scratch = await makeScratchWorkspaceHarness(workspace => {
      workspace.write(PRIMARY, PRIMARY_SOURCE);
      workspace.write(SECONDARY, SECONDARY_SOURCE);
   });
   const { harness, workspace } = scratch;
   const primaryUri = URI.file(workspace.resolve(PRIMARY));
   const secondaryUri = URI.file(workspace.resolve(SECONDARY));

   const reasons: string[] = [];
   harness.shared.workspace.AstDocumentManager.onUpdate(primaryUri.toString(), event => reasons.push(event.reason));
   return { harness, primaryUri, secondaryUri, reasons };
}

describe('TransferUpdatedEvent.reason against a real DocumentBuilder', () => {
   // The control for the case below: it proves the subscription, the URI form
   // and the phase listener line up, so a later empty `reasons` is evidence of
   // absence rather than of a probe that cannot observe anything at all.
   it("delivers 'changed' for a URI in the changed list", async () => {
      const { harness, primaryUri, reasons } = await buildFixture();

      await harness.shared.workspace.DocumentBuilder.update([primaryUri], []);

      expect(reasons).toEqual(['changed']);
   });

   it('delivers nothing at all for a deleted URI, which reaches no phase listener', async () => {
      const { harness, primaryUri, reasons } = await buildFixture();

      await harness.shared.workspace.DocumentBuilder.update([], [primaryUri]);

      // `update` removes the document from `LangiumDocuments` before computing
      // the build set, so it cannot be in the batch and cannot reach the
      // `Validated` listener that emits this event. The awaited `update` is a
      // real completion point, so the empty array is not a sampling race.
      expect(reasons).toEqual([]);
      expect(harness.shared.workspace.LangiumDocuments.getDocument(primaryUri)).toBeUndefined();
   });
});
