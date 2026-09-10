/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The data head, **driven** rather than merely launched.
 *
 * `main.ts` publishes a data-server port; nothing about that wiring is proved
 * until a client actually issues the requests. Two things worth carrying into
 * an adopter's own head: the write path exercised here is the one a form editor
 * takes, and the head must be typed with the TRANSFER roots rather than the AST
 * roots — in the transfer model `Reference<T>` is `string` rather than a Langium
 * reference object. Both shapes satisfy `TransferElement` structurally, so
 * nothing complains until a test has to name the type it actually received.
 *
 * What this suite owns that no other can: **two grammars over one connection.**
 * There is a single `DataServer` per client, serving both `.domain` and
 * `.process`, so every request has to route to the right language's serializer
 * and encoder by URI alone. A single-grammar example cannot tell a correct
 * router from one that always answers with the only language it has.
 *
 * The workspace is a scratch copy, because the write paths here reach disk on
 * `saveModelDocument` and because a rebuild runs the integrity rules.
 */

import { TransferDocument } from '@hydranium/protocol';
import { DataServer, type DataServerOptions } from '@hydranium/data-server';
import { makeDataServerHarness, type DataServerHarness } from '@hydranium/data-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { DocumentState } from '@hydranium/langium';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainModel, ProcessModel } from '../src/language-server/generated-hydranium/transfer-model.js';
import { isProcessModel, isTask } from '../src/language-server/generated-hydranium/transfer-model.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness } from './order-flow-harness.js';

type OrderFlowTransfer = DomainModel | ProcessModel;

const CLIENT_ID = 'data-server-test';

let workspace: ScratchWorkspace | undefined;
let harness: DataServerHarness<DataServer<OrderFlowTransfer>, OrderFlowTransfer> | undefined;

interface DrivenHead {
   readonly harness: DataServerHarness<DataServer<OrderFlowTransfer>, OrderFlowTransfer>;
   /** Absolute URI of a workspace file, which is what the wire carries. */
   readonly uri: (relativePath: string) => string;
   /** Current on-disk text, for asserting what `saveModelDocument` wrote. */
   readonly diskText: (relativePath: string) => string;
}

/** Boot both languages over a scratch workspace and put a real DataServer on a duplex pair. */
async function driveDataHead(options?: DataServerOptions): Promise<DrivenHead> {
   const { harness: services, workspace: scratch } = await makeScratchWorkspaceHarness();
   workspace = scratch;
   harness = makeDataServerHarness<DataServer<OrderFlowTransfer>, OrderFlowTransfer>({
      server: channel => new DataServer<OrderFlowTransfer>(channel, services.shared, options)
   });
   return {
      harness,
      uri: relativePath => scratch.uri(relativePath),
      diskText: relativePath => readFileSync(scratch.resolve(relativePath), 'utf8')
   };
}

describe('order-flow data head', () => {
   afterEach(() => {
      harness?.dispose();
      harness = undefined;
      workspace?.dispose();
      workspace = undefined;
   });

   it('serves both grammars over one connection, each as its own transfer root', async () => {
      const head = await driveDataHead();

      const domain = await head.harness.proxy.openModelDocument({
         uri: head.uri(WORKSPACE_FILES.ordersDomain),
         clientId: CLIENT_ID
      });
      const process = await head.harness.proxy.openModelDocument({
         uri: head.uri(WORKSPACE_FILES.fulfillmentProcess),
         clientId: CLIENT_ID
      });

      // Routing by URI alone: one server, two languages, two different root
      // types. Asserting the $type rather than just "no throw" is what
      // distinguishes a real router from one answering with its only language.
      expect(domain.root?.$type).toBe('DomainModel');
      expect(process.root?.$type).toBe('ProcessModel');
      expect(isProcessModel(process.root)).toBe(true);
   });

   it('encodes a cross-reference as its name, not as a reference object', async () => {
      const head = await driveDataHead();

      const document = await head.harness.proxy.openModelDocument({
         uri: head.uri(WORKSPACE_FILES.fulfillmentProcess),
         clientId: CLIENT_ID
      });

      // The wire shape, and the reason `main.ts` naming the AST roots was a
      // type-level lie: `Reference<T>` is `string` in the transfer model, so a
      // client typed off the AST would reach for `.ref` on a bare name.
      const root = document.root as ProcessModel;
      expect(root.subject).toBe('Order');
      expect(typeof root.subject).toBe('string');
   });

   it('answers a one-shot includeDiagnostics read on a freshly initialized workspace', async () => {
      const head = await driveDataHead();

      // The documented use case for the flag — "one-shot / unsubscribed caller,
      // CLI query, batch check" — against the state a workspace is actually in
      // straight after `initialize`: linked and indexed, but NOT validated,
      // because Langium's default `initialBuildOptions` leave `validation`
      // unset. No prior open/update, so nothing else has driven a build.
      //
      // The hazard: `getModelDocument({ includeDiagnostics: true })` settles at
      // `Validated`, and the framework's `awaitDocumentState` replaces Langium's
      // "workspace already past that state" rejection with a wait. If only a
      // later build's `Validated` build-phase event can satisfy that wait, this
      // read never returns — after init there is no later build. Every one-shot
      // read on a freshly initialized workspace rides on it, `hydranium-cli
      // query` included.
      const leaked = await head.harness.proxy.getModelDocument({
         uri: head.uri(WORKSPACE_FILES.auditLeak),
         includeDiagnostics: true
      });

      // Asserting the CONTENT, not just that the promise settled: a fix that
      // resolved the wait without actually validating would pass an
      // "it resolves" test and return an empty array here. `audit-leak.domain`
      // is the workspace's one deliberate error (a cross-project reference to a
      // non-`public` declaration), so this pins that validation really ran.
      expect(leaked.diagnostics).toHaveLength(1);
      expect(leaked.diagnostics[0]).toMatchObject({ severity: 'error' });
      expect(leaked.diagnostics[0].message).toContain('AuditStamp');

      // The control on the assertion above: a clean file over the same head
      // reports zero, so "1 diagnostic" is this document's error rather than
      // something the read reports for anything it is handed.
      const clean = await head.harness.proxy.getModelDocument({
         uri: head.uri(WORKSPACE_FILES.ordersDomain),
         includeDiagnostics: true
      });
      expect(clean.diagnostics).toEqual([]);
   });

   it('round-trips a TYPED transfer model through updateModelDocument', async () => {
      const head = await driveDataHead();
      const path = WORKSPACE_FILES.fulfillmentProcess;

      const opened = await head.harness.proxy.openModelDocument({ uri: head.uri(path), clientId: CLIENT_ID });
      const root = opened.root as ProcessModel;
      const pay = root.nodes.filter(isTask).find(task => task.name === 'Pay');
      expect(pay?.effects).toHaveLength(1);

      // Control that the fixture really carries the three-part effect this test
      // is about, rather than assuming it.
      expect(head.diskText(path)).toContain('writes Order.status = PAID');

      const renamed: ProcessModel = {
         ...root,
         nodes: root.nodes.map(node => (isTask(node) && node.name === 'Pay' ? { ...node, name: 'Settle' } : node))
      };
      const updated = await head.harness.proxy.updateModelDocument({
         uri: head.uri(path),
         clientId: CLIENT_ID,
         model: renamed
      });

      // `model` is `T | string`, and this drives the T branch — the one that
      // carried the live defect where a hand-written serializer blanked every
      // transfer-mode cross-reference, turning `writes Order.status = PAID`
      // into `writes . = `. A string payload would not have reached it.
      const updatedRoot = updated.root as ProcessModel;
      expect(updatedRoot.nodes.filter(isTask).map(task => task.name)).toContain('Settle');
      const settle = updatedRoot.nodes.filter(isTask).find(task => task.name === 'Settle');
      expect(settle?.effects[0]?.entity).toBe('Order');
      expect(settle?.effects[0]?.field).toBe('status');
   });

   it('reports the two folder-scoped projects and resolves a URI to its own', async () => {
      const head = await driveDataHead();

      const projects = await head.harness.proxy.getProjects();
      const owning = await head.harness.proxy.getProjectForUri({ uri: head.uri(WORKSPACE_FILES.ordersDomain) });

      // The example's project descriptors are a strict subset of its model
      // files, which is the topology the project tier is here to exercise.
      expect(projects.length).toBeGreaterThanOrEqual(2);
      expect(owning).toBeDefined();
      expect(projects.map(project => project.id)).toContain(owning!.id);
   });

   it('notifies a watching client when the document it watches is updated', async () => {
      const head = await driveDataHead();
      const uri = head.uri(WORKSPACE_FILES.fulfillmentProcess);
      await head.harness.proxy.openModelDocument({ uri, clientId: CLIENT_ID });
      await head.harness.proxy.watchModelDocument({ uri, clientId: CLIENT_ID });
      const before = head.harness.events.length;

      await head.harness.proxy.updateModelDocument({
         uri,
         clientId: CLIENT_ID,
         model: 'process Fulfillment for Order {\n   task Pay\n}'
      });

      expect(head.harness.events.length).toBeGreaterThan(before);
      const event = head.harness.events[head.harness.events.length - 1];
      expect(event.document.uri).toBe(uri);
      expect(event.sourceClientId).toBe(CLIENT_ID);
      // The notification carries the projected document, not just a signal.
      expect((event.document.root as ProcessModel).nodes.map(node => node.name)).toEqual(['Pay']);
   });

   it('writes to disk on save, and tells the client it happened', async () => {
      const head = await driveDataHead();
      const path = WORKSPACE_FILES.fulfillmentProcess;
      const uri = head.uri(path);
      await head.harness.proxy.openModelDocument({ uri, clientId: CLIENT_ID });
      await head.harness.proxy.watchModelDocument({ uri, clientId: CLIENT_ID });
      const updated = await head.harness.proxy.updateModelDocument({
         uri,
         clientId: CLIENT_ID,
         model: 'process Fulfillment for Order {\n   task Settle\n}'
      });
      // Control: update alone is in-memory, so disk must still hold the original.
      expect(head.diskText(path)).toContain('task Pay');

      const updatedRoot = TransferDocument.assertLoaded(updated).root;
      await head.harness.proxy.saveModelDocument({ uri, clientId: CLIENT_ID, model: updatedRoot });

      expect(head.diskText(path)).toContain('task Settle');
      expect(head.harness.saves.map(save => save.document.uri)).toContain(uri);
   });

   /**
    * `DataServerOptions.subscriptionPhase` — the two tests below are a matched
    * pair over ONE fixture, and only the pair distinguishes a head that honours
    * the option from one that ignores it.
    *
    * The option's purpose is a latency/completeness trade: validation can take
    * seconds on a real workspace, so an adopter that publishes validation
    * diagnostics through a separate channel (typically LSP
    * `publishDiagnostics`) can fire subscription events at an earlier phase and
    * let clients observe diagnostics asynchronously via that channel. So the
    * observable difference is exactly whether the event payload carries
    * diagnostics — which is what these two assert, over
    * `orders/audit-leak.domain`, the workspace's one deliberate error.
    *
    * Why the pair needs a NON-default phase: `DocumentState.Validated` IS
    * `DataServer.DEFAULT_OPTIONS.subscriptionPhase`, so configuring it cannot
    * tell "honoured" from "defaulted" — such a test passes with the option
    * deleted from the constructor altogether.
    */
   it('fires subscription events at the default Validated phase, carrying the full diagnostic set', async () => {
      const head = await driveDataHead();
      const uri = head.uri(WORKSPACE_FILES.auditLeak);
      await head.harness.proxy.openModelDocument({ uri, clientId: CLIENT_ID });
      await head.harness.proxy.watchModelDocument({ uri, clientId: CLIENT_ID });
      const before = head.harness.events.length;

      // Renaming the entity provokes a rebuild while KEEPING the unresolvable
      // `AuditStamp` reference, so the error survives the edit and the phase is
      // the only variable between this test and the next.
      await head.harness.proxy.updateModelDocument({
         uri,
         clientId: CLIENT_ID,
         model: 'entity ShipmentAudit {\n   stamp: AuditStamp\n}'
      });

      const fired = head.harness.events.slice(before);
      expect(fired.length).toBeGreaterThan(0);
      const last = fired[fired.length - 1];
      expect(last.document.diagnostics).toHaveLength(1);
      expect(last.document.diagnostics[0].message).toContain('AuditStamp');
   });

   it('honours a non-default subscriptionPhase, firing before validation has run', async () => {
      const head = await driveDataHead({ subscriptionPhase: DocumentState.IndexedReferences });
      const uri = head.uri(WORKSPACE_FILES.auditLeak);
      await head.harness.proxy.openModelDocument({ uri, clientId: CLIENT_ID });
      await head.harness.proxy.watchModelDocument({ uri, clientId: CLIENT_ID });
      const before = head.harness.events.length;

      await head.harness.proxy.updateModelDocument({
         uri,
         clientId: CLIENT_ID,
         model: 'entity ShipmentAudit {\n   stamp: AuditStamp\n}'
      });

      const fired = head.harness.events.slice(before);
      expect(fired.length).toBeGreaterThan(0);
      // EVERY event, not just the last: one listener is registered, at the
      // configured phase, so a head that also fired at `Validated` would show up
      // here as an extra event carrying the diagnostic.
      for (const event of fired) {
         expect(event.document.diagnostics).toEqual([]);
      }
      // And the payload is a real projection, not an empty envelope that would
      // trivially satisfy the assertion above.
      expect(head.harness.events[head.harness.events.length - 1].document.uri).toBe(uri);
   });
});
