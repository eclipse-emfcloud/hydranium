/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A session write answers with its document validated, whichever build carried
 * it, so its answer is never older than the update event that echoes it.
 *
 * The echo carries the writer's id, and a client drops its own echo. So an
 * answer taken before validation loses the diagnostics for good whenever the
 * writer's own build is cancelled and a later build validates the document,
 * as another client's edit does. The writer's own `updateAll` shares one
 * build between its documents, and its answers wait for that build too.
 *
 * Needs the real builder and write lock: the loss is the cancelled build.
 */

import { DocumentState } from '@hydranium/langium';
import { afterEach, describe, expect, it } from 'vitest';
import { makeScratchWorkspaceHarness, type OrderFlowHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const CUSTOMER = 'orders/validated-customer.domain';
const ORDER = 'orders/validated-order.domain';
const LONE = 'orders/validated-lone.domain';
const CUSTOMER_SOURCE = `entity ValidatedCustomer {
   name: string
}
`;
const CUSTOMER_RENAMED = `entity ValidatedClient {
   name: string
}
`;
const ORDER_SOURCE = `entity ValidatedOrder {
   customer: ValidatedCustomer
}
`;
const ORDER_EDITED = `entity ValidatedOrder {
   customer: ValidatedCustomer
   backup: ValidatedCustomer
}
`;
const ORDER_BROKEN = `entity ValidatedOrder {
   customer: NoSuchThing
}
`;
const LONE_SOURCE = `entity ValidatedLone {
   id: string
}
`;
const LONE_EDITED = `entity ValidatedLone {
   id: string
   code: string
}
`;

let scratch: ScratchOrderFlowHarness | undefined;

afterEach(() => {
   scratch?.workspace.dispose();
   scratch = undefined;
});

async function boot(): Promise<{ harness: OrderFlowHarness; uri: (file: string) => string }> {
   scratch = await makeScratchWorkspaceHarness(workspace => {
      workspace.write(CUSTOMER, CUSTOMER_SOURCE);
      workspace.write(ORDER, ORDER_SOURCE);
      workspace.write(LONE, LONE_SOURCE);
   });
   const { harness, workspace } = scratch;
   return { harness, uri: file => workspace.uri(file) };
}

/**
 * Start `write` once `uri` is parsed in the build under way, and hold that
 * build until the write has taken the lock and cancelled it.
 *
 * The write starts from the test's own async context: started inside the
 * listener, it would run as the lock holder and be refused as reentrant.
 */
function writeDuringBuildOf(harness: OrderFlowHarness, uri: string, write: () => Promise<unknown>): Promise<unknown> {
   const workspace = harness.shared.workspace;
   const target = workspace.DocumentUriPolicy.canonicalUri(uri);
   let reached!: () => void;
   const written = new Promise<void>(resolve => (reached = resolve)).then(write);
   const listener = workspace.DocumentBuilder.onDocumentPhase(DocumentState.Parsed, async (document, cancelToken) => {
      if (workspace.DocumentUriPolicy.canonicalUri(document.uri.toString()) === target) {
         listener.dispose();
         reached();
         // Held until the write cancels this build; the timeout, well inside
         // the test's own, only keeps a write that never comes from hanging it.
         await new Promise<void>(resolve => {
            const timer = setTimeout(done, 2000);
            const cancelled = cancelToken.onCancellationRequested(done);
            function done(): void {
               clearTimeout(timer);
               cancelled.dispose();
               resolve();
            }
         });
      }
   });
   return written;
}

describe('a session write answers with its document validated', () => {
   it('when another client edits a dependency during the write’s build, which cancels it', async () => {
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const panel = models.createSession('panel', 'panel');
      const editor = models.createSession('editor', 'editor');
      await panel.open(uri(ORDER));
      await editor.open(uri(CUSTOMER));
      await models.validated(uri(ORDER));

      const renamed = writeDuringBuildOf(harness, uri(ORDER), () =>
         editor.update({ uri: uri(CUSTOMER), model: CUSTOMER_RENAMED, basedOn: 'anything' })
      );
      const answer = await panel.update({ uri: uri(ORDER), model: ORDER_EDITED, basedOn: 'anything' });
      await renamed;

      // Both references now fail to resolve. Before validation the answer
      // carries none of it, and the echo naming the panel is dropped.
      const server = await models.validated(uri(ORDER));
      expect(server.diagnostics).toHaveLength(2);
      expect(answer.diagnostics).toHaveLength(2);
   });

   it('when the writer’s own updateAll builds its documents together', async () => {
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const writer = models.createSession('writer', 'writer');
      await writer.open(uri(ORDER));
      await writer.open(uri(LONE));
      await models.validated(uri(ORDER));
      await models.validated(uri(LONE));

      const [order] = await writer.updateAll({
         updates: [
            { uri: uri(ORDER), model: ORDER_BROKEN, basedOn: 'anything' },
            { uri: uri(LONE), model: LONE_EDITED, basedOn: 'anything' }
         ]
      });

      expect(order.diagnostics.map(diagnostic => diagnostic.message)).toEqual([expect.stringContaining('NoSuchThing')]);
   });

   it('answers unvalidated when rebuilds do not validate, rather than waiting for a phase no build reaches', async () => {
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const writer = models.createSession('writer', 'writer');
      await writer.open(uri(ORDER));
      harness.shared.workspace.DocumentBuilder.updateBuildOptions = { validation: false };

      const answer = await writer.update({ uri: uri(ORDER), model: ORDER_BROKEN, basedOn: 'anything' });

      expect(answer.root).toBeDefined();
      expect(models.getDocument(uri(ORDER))?.state).toBeLessThan(DocumentState.Validated);
   });
});
