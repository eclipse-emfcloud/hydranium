/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Which client an update event names, measured against the real builder.
 *
 * An event's `sourceClientId` says whose write it echoes, and a client drops
 * its own echo. So a rebuild credited to the wrong client is lost to that
 * client: the version's author, when a dependency changed under it, or the
 * writer of a document whose build a later write cancelled and folded into
 * its own. `causedBy` names the client whose write caused the build, which
 * the diagram reads to skip resubmitting for its own writes.
 *
 * Needs the real builder: the misattributions come from cancelled and folded
 * builds and from the reference graph, neither of which a stub has.
 */

import { type AstDocumentUpdatedEvent, UNKNOWN_CLIENT_ID } from '@hydranium/core';
import { DataServer } from '@hydranium/data-server';
import { makeDataServerHarness } from '@hydranium/data-server/testing';
import { type AstNode, Deferred, DocumentState, URI } from '@hydranium/langium';
import { waitFor } from '@hydranium/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainModel } from '../src/language-server/generated-hydranium/transfer-model.js';
import { makeScratchWorkspaceHarness, type OrderFlowHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const CUSTOMER = 'orders/attribution-customer.domain';
const ORDER = 'orders/attribution-order.domain';
const LONE = 'orders/attribution-lone.domain';
const CUSTOMER_SOURCE = `entity AttributionCustomer {
   name: string
}
`;
const CUSTOMER_RENAMED = `entity AttributionClient {
   name: string
}
`;
const CUSTOMER_EDITED = `entity AttributionCustomer {
   name: string
   email: string
}
`;
const ORDER_SOURCE = `entity AttributionOrder {
   customer: AttributionCustomer
}
`;
const ORDER_EDITED = `entity AttributionOrder {
   customer: AttributionCustomer
   note: string
}
`;
const LONE_SOURCE = `entity AttributionLone {
   id: string
}
`;
const LONE_EDITED = `entity AttributionLone {
   id: string
   code: string
}
`;

type Event = AstDocumentUpdatedEvent<AstNode>;

let scratch: ScratchOrderFlowHarness | undefined;
const disposables: { dispose(): void }[] = [];

afterEach(() => {
   disposables.splice(0).forEach(disposable => disposable.dispose());
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

/** Every update event for `uri` from now on. */
function record(harness: OrderFlowHarness, uri: string): Event[] {
   const events: Event[] = [];
   harness.shared.model.ModelService.onModelUpdated(uri, event => events.push(event));
   return events;
}

const attribution = (event: Event): Pick<Event, 'reason' | 'sourceClientId' | 'causedBy'> => ({
   reason: event.reason,
   sourceClientId: event.sourceClientId,
   causedBy: event.causedBy
});

describe('update attribution against the real builder', () => {
   it('does not credit a dependency’s rebuild to the client that opened the document', async () => {
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const panel = models.createSession('panel', 'panel');
      const editor = models.createSession('editor', 'editor');
      await panel.open(uri(ORDER));
      await editor.open(uri(CUSTOMER));
      await models.validated(uri(ORDER));
      const events = record(harness, uri(ORDER));

      await editor.update({ uri: uri(CUSTOMER), model: CUSTOMER_RENAMED, basedOn: 'anything' });
      await models.validated(uri(ORDER));

      expect(events.length).toBeGreaterThan(0);
      expect(events.map(attribution)).toEqual(
         events.map(() => ({ reason: 'rebuilt', sourceClientId: UNKNOWN_CLIENT_ID, causedBy: 'editor' }))
      );
      expect(events.some(event => panel.isOwnEcho(event.sourceClientId))).toBe(false);
   });

   it('credits the client’s own write of the document to it', async () => {
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const panel = models.createSession('panel', 'panel');
      await panel.open(uri(ORDER));
      await models.validated(uri(ORDER));
      const events = record(harness, uri(ORDER));

      await panel.update({ uri: uri(ORDER), model: ORDER_EDITED, basedOn: 'anything' });

      expect(events.map(attribution)).toEqual([{ reason: 'changed', sourceClientId: 'panel', causedBy: 'panel' }]);
      expect(panel.isOwnEcho(events[0].sourceClientId)).toBe(true);
   });

   it('credits every document of an updateAll to the writer, the one whose build was cancelled included', async () => {
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const writer = models.createSession('writer', 'writer');
      await writer.open(uri(CUSTOMER));
      await writer.open(uri(LONE));
      await models.validated(uri(CUSTOMER));
      await models.validated(uri(LONE));
      const customerEvents = record(harness, uri(CUSTOMER));
      const loneEvents = record(harness, uri(LONE));

      await writer.updateAll({
         updates: [
            { uri: uri(CUSTOMER), model: CUSTOMER_EDITED, basedOn: 'anything' },
            { uri: uri(LONE), model: LONE_EDITED, basedOn: 'anything' }
         ]
      });

      const expected = { reason: 'changed', sourceClientId: 'writer', causedBy: 'writer' };
      expect(customerEvents.map(attribution)).toEqual([expected]);
      expect(loneEvents.map(attribution)).toEqual([expected]);
   });

   it('names the writer as the cause of a document its build swept in, and nobody else', async () => {
      // The swept-in document is below Validated when the build starts, which
      // is what pulls it into a build its own text had no part in.
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const diagram = models.createSession('diagram', 'diagram');
      const editor = models.createSession('editor', 'editor');
      await diagram.open(uri(ORDER));
      await diagram.open(uri(LONE));
      await editor.open(uri(LONE));
      await models.validated(uri(ORDER));
      await models.validated(uri(LONE));
      const builder = harness.shared.workspace.DocumentBuilder;
      const order = (): NonNullable<ReturnType<typeof models.getDocument>> => models.getDocument(uri(ORDER))!;
      const events = record(harness, uri(ORDER));

      builder.resetToState(order(), DocumentState.IndexedReferences);
      await diagram.update({ uri: uri(LONE), model: LONE_EDITED, basedOn: 'anything' });
      builder.resetToState(order(), DocumentState.IndexedReferences);
      await editor.update({ uri: uri(LONE), model: LONE_SOURCE, basedOn: 'anything' });

      expect(events.map(attribution)).toEqual([
         { reason: 'rebuilt', sourceClientId: UNKNOWN_CLIENT_ID, causedBy: 'diagram' },
         { reason: 'rebuilt', sourceClientId: UNKNOWN_CLIENT_ID, causedBy: 'editor' }
      ]);
   });

   it('credits a write that changes nothing to nobody', async () => {
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const first = models.createSession('first', 'first');
      const second = models.createSession('second', 'second');
      await first.open(uri(LONE));
      await second.open(uri(LONE));
      await first.update({ uri: uri(LONE), model: LONE_EDITED, basedOn: 'anything' });
      const events = record(harness, uri(LONE));

      await second.update({ uri: uri(LONE), model: LONE_EDITED, basedOn: 'anything' });

      expect(events.map(attribution)).toEqual([{ reason: 'rebuilt', sourceClientId: UNKNOWN_CLIENT_ID, causedBy: UNKNOWN_CLIENT_ID }]);
   });

   it('credits the revert to unchanged text after the last close to nobody', async () => {
      // The revert rebuilds from disk under the version the store continues,
      // and the delivery of that version can land after the close.
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const reader = models.createSession('reader', 'reader');
      await reader.open(uri(LONE));
      await models.validated(uri(LONE));
      const events = record(harness, uri(LONE));

      await reader.close(uri(LONE));

      await waitFor(() => events.length > 0, { message: 'no update event for the revert' });
      expect(events.map(attribution)).toEqual(
         events.map(() => ({ reason: 'rebuilt', sourceClientId: UNKNOWN_CLIENT_ID, causedBy: UNKNOWN_CLIENT_ID }))
      );
   });

   it('reports a change to a document no client opened as changed', async () => {
      const { harness, uri } = await boot();
      const events = record(harness, uri(LONE));

      await harness.shared.workspace.DocumentBuilder.update([URI.parse(uri(LONE))], []);

      expect(events.map(event => event.reason)).toEqual(['changed']);
   });
});

describe('update attribution over the data head', () => {
   /** A data-server connection on `harness` with a session `clientId` registered on it. */
   async function connect(harness: OrderFlowHarness, clientId: string) {
      const head = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({
         server: channel => new DataServer<DomainModel>(channel, harness.shared)
      });
      disposables.push(head);
      await head.proxy.createSession({ clientId });
      return head;
   }

   it('does not send a dependency’s rebuild as the echo of the client that opened the document', async () => {
      const { harness, uri } = await boot();
      const panel = await connect(harness, 'panel');
      await panel.proxy.openModelDocument({ uri: uri(ORDER), clientId: 'panel' });
      await panel.proxy.getModelDocument({ uri: uri(ORDER), includeDiagnostics: true });
      await panel.proxy.watchModelDocument({ uri: uri(ORDER), clientId: 'panel' });
      const editor = harness.shared.model.ModelService.createSession('editor', 'editor');
      await editor.open(uri(CUSTOMER));

      await editor.update({ uri: uri(CUSTOMER), model: CUSTOMER_RENAMED, basedOn: 'anything' });

      await waitFor(() => panel.events.some(event => event.document.uri === uri(ORDER)), {
         message: 'no update event for the dependent document'
      });
      const sent = panel.events.filter(event => event.document.uri === uri(ORDER));
      expect(sent.map(event => [event.reason, event.sourceClientId])).toEqual(sent.map(() => ['rebuilt', UNKNOWN_CLIENT_ID]));
      expect(sent.at(-1)?.document.diagnostics.length).toBeGreaterThan(0);
   });

   it('falls back to the last update when rebuilds do not validate, rather than crediting every event to its author', async () => {
      // No version is ever delivered without validation, so the version rule
      // would report the dependency's rebuild as the opener's change. The
      // rebuild changes nothing a fingerprint sees before validation, so the
      // server sends every event.
      const { harness, uri } = await boot();
      harness.shared.workspace.DocumentBuilder.updateBuildOptions = { validation: false };
      let emitted = 0;
      class EveryEventServer extends DataServer<DomainModel> {
         protected override additionalFingerprintInputs(): readonly unknown[] {
            return [emitted++];
         }
      }
      const head = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({
         server: channel => new EveryEventServer(channel, harness.shared, { subscriptionPhase: DocumentState.IndexedReferences })
      });
      disposables.push(head);
      await head.proxy.createSession({ clientId: 'panel' });
      await head.proxy.openModelDocument({ uri: uri(ORDER), clientId: 'panel' });
      await head.proxy.watchModelDocument({ uri: uri(ORDER), clientId: 'panel' });
      const editor = harness.shared.model.ModelService.createSession('editor', 'editor');
      await editor.open(uri(CUSTOMER));

      await editor.update({ uri: uri(CUSTOMER), model: CUSTOMER_RENAMED, basedOn: 'anything' });

      await waitFor(() => head.events.some(event => event.document.uri === uri(ORDER)), {
         message: 'no update event for the dependent document'
      });
      const sent = head.events.filter(event => event.document.uri === uri(ORDER));
      expect(sent.map(event => [event.reason, event.sourceClientId])).toEqual(sent.map(() => ['rebuilt', UNKNOWN_CLIENT_ID]));
   });

   it('sends a version it already sent as rebuilt when a build before Validated is cancelled', async () => {
      // A head below `Validated` sends a version before the manager marks it
      // delivered at `Validated`, so a build cancelled between the two phases
      // leaves the version undelivered for the next build. The fingerprint
      // hides the repeat unless something the watcher sees changed, which a
      // dependency's change does; the probe counts every event instead.
      const { harness, uri } = await boot();
      let emitted = 0;
      class EveryEventServer extends DataServer<DomainModel> {
         protected override additionalFingerprintInputs(): readonly unknown[] {
            return [emitted++];
         }
      }
      const head = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({
         server: channel => new EveryEventServer(channel, harness.shared, { subscriptionPhase: DocumentState.IndexedReferences })
      });
      disposables.push(head);
      await head.proxy.createSession({ clientId: 'panel' });
      await head.proxy.openModelDocument({ uri: uri(LONE), clientId: 'panel' });
      await head.proxy.watchModelDocument({ uri: uri(LONE), clientId: 'panel' });
      const writer = harness.shared.model.ModelService.createSession('writer', 'writer');
      await writer.open(uri(LONE));
      const builder = harness.shared.workspace.DocumentBuilder;
      const reachedBarrier = new Deferred<void>();
      const release = new Deferred<void>();
      let barrierArmed = true;
      disposables.push(
         builder.onBuildPhase(DocumentState.IndexedReferences, async () => {
            if (!barrierArmed) {
               return;
            }
            barrierArmed = false;
            reachedBarrier.resolve();
            await release.promise;
         })
      );

      const written = writer.update({ uri: uri(LONE), model: LONE_EDITED, basedOn: 'anything' });
      await reachedBarrier.promise;
      const rebuilt = harness.shared.workspace.WorkspaceLock.write(token => builder.update([URI.parse(uri(LONE))], [], token));
      release.resolve();
      await Promise.all([written, rebuilt]);
      // A round trip on the same connection flushes the notifications sent before it.
      await head.proxy.getModelDocument({ uri: uri(ORDER) });

      const sent = head.events.filter(event => event.document.uri === uri(LONE)).map(event => [event.reason, event.sourceClientId]);
      expect(sent).toEqual([
         ['changed', 'writer'],
         ['rebuilt', UNKNOWN_CLIENT_ID]
      ]);
   });

   it('sends each change to a watched file no client has open as changed', async () => {
      // Such a document keeps one version through every change of its file, so
      // a repeated version says nothing about a repeated text there.
      const { harness, uri } = await boot();
      const panel = await connect(harness, 'panel');
      await panel.proxy.watchModelDocument({ uri: uri(LONE), clientId: 'panel' });
      const builder = harness.shared.workspace.DocumentBuilder;

      for (const text of [LONE_EDITED, LONE_SOURCE]) {
         scratch?.workspace.write(LONE, text);
         await builder.update([URI.parse(uri(LONE))], []);
      }
      // A round trip on the same connection flushes the notifications sent before it.
      await panel.proxy.getModelDocument({ uri: uri(ORDER) });

      expect(panel.events.filter(event => event.document.uri === uri(LONE)).map(event => event.reason)).toEqual(['changed', 'changed']);
   });

   it('sends every document of an updateAll as the writer’s change', async () => {
      const { harness, uri } = await boot();
      const writer = await connect(harness, 'writer');
      for (const file of [CUSTOMER, LONE]) {
         await writer.proxy.openModelDocument({ uri: uri(file), clientId: 'writer' });
         await writer.proxy.getModelDocument({ uri: uri(file), includeDiagnostics: true });
         await writer.proxy.watchModelDocument({ uri: uri(file), clientId: 'writer' });
      }

      await writer.proxy.updateModelDocuments({
         clientId: 'writer',
         updates: [
            { uri: uri(CUSTOMER), model: CUSTOMER_EDITED, basedOn: 'anything' },
            { uri: uri(LONE), model: LONE_EDITED, basedOn: 'anything' }
         ]
      });
      // A round trip on the same connection flushes the notifications sent before it.
      await writer.proxy.getModelDocument({ uri: uri(ORDER) });

      const sent = writer.events.map(event => [event.document.uri, event.reason, event.sourceClientId].join(' '));
      expect(sent.sort()).toEqual([`${uri(CUSTOMER)} changed writer`, `${uri(LONE)} changed writer`].sort());
   });
});
