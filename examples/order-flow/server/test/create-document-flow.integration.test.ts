/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The **create-document flow**: populating a reference picker for a file that
 * does not exist yet, then writing it.
 *
 * `ProcessModel` opens `process <name> for <subject=[Entity]>`, so a "New
 * Process" dialog cannot offer anything until it knows which entities are in
 * scope — and it has to ask BEFORE the file exists. The only URI it holds at
 * that point is the FOLDER the file is going into, which names no file and so
 * carries no extension for the language-routing ladder to end on.
 *
 * That makes this the one flow where the framework must resolve a language from
 * something other than the URI: `HydraniumScopeProvider` is bound per grammar,
 * so the provider the request routed to supplies its own. The example binds
 * nothing for it — a `SyntheticSource` at a folder is answered by the framework
 * default.
 *
 * Distinct from the GLSP create handlers, which add a node to a document that
 * is already open and therefore always have a real file URI. Nothing in that
 * path exercises a folder URI, which is why this flow needs its own coverage.
 */

import { ReferenceSource, SyntheticStep } from '@hydranium/protocol';
import { DataServer } from '@hydranium/data-server';
import { makeDataServerHarness, type DataServerHarness } from '@hydranium/data-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainModel, ProcessModel } from '../src/language-server/generated-hydranium/transfer-model.js';
import { makeScratchWorkspaceHarness } from './order-flow-harness.js';

type OrderFlowTransfer = DomainModel | ProcessModel;

let workspace: ScratchWorkspace | undefined;
let harness: DataServerHarness<DataServer<OrderFlowTransfer>, OrderFlowTransfer> | undefined;

/** Boot all three languages over a scratch workspace with a real data head on it. */
async function driveDataHead(): Promise<{
   readonly server: DataServer<OrderFlowTransfer>;
   readonly folderUri: (relativePath: string) => string;
}> {
   const { harness: services, workspace: scratch } = await makeScratchWorkspaceHarness();
   workspace = scratch;
   harness = makeDataServerHarness<DataServer<OrderFlowTransfer>, OrderFlowTransfer>({
      server: channel => new DataServer<OrderFlowTransfer>(channel, services.shared)
   });
   return { server: harness.server, folderUri: relativePath => scratch.uri(relativePath) };
}

/** What a "New Process in `orders/`" dialog asks for its `subject` picker. */
function subjectPickerRequest(folderUri: string): Parameters<DataServer<OrderFlowTransfer>['findReferenceCandidates']>[0] {
   return {
      source: ReferenceSource.synthetic(folderUri, 'ProcessModel'),
      property: 'subject'
   };
}

describe('creating a document that does not exist yet', () => {
   afterEach(() => {
      harness?.dispose();
      harness = undefined;
      workspace?.dispose();
      workspace = undefined;
   });

   it('offers the in-scope entities for a file whose folder is all the caller knows', async () => {
      const head = await driveDataHead();

      const candidates = await head.server.findReferenceCandidates(subjectPickerRequest(head.folderUri('orders')));

      // The picker is populated from the project's visibility closure, with no
      // document anywhere near the URI that was asked about.
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.map(candidate => candidate.label)).toContain('Order');
   });

   it('applies project visibility to the folder it was asked about, not to the workspace', async () => {
      const head = await driveDataHead();

      const fromOrders = await head.server.findReferenceCandidates(subjectPickerRequest(head.folderUri('orders')));
      const fromCommerceCore = await head.server.findReferenceCandidates(subjectPickerRequest(head.folderUri('commerce-core')));

      // `orders` requires `commerce-core`, and the dependency is one-way — so
      // the two folders must not answer the same set. A stand-in that ignored
      // which folder it stood in would make these identical, which is the
      // assertion a single-project workspace cannot make.
      const ordersLabels = fromOrders.map(candidate => candidate.label);
      const coreLabels = fromCommerceCore.map(candidate => candidate.label);
      expect(ordersLabels).not.toEqual(coreLabels);
      expect(coreLabels).not.toContain('Order');
   });

   it('answers for a folder that holds no document of the asking grammar at all', async () => {
      const head = await driveDataHead();

      // `commerce-core` holds only `.domain` files, so the process grammar has
      // nothing loaded there. The stand-in still has to parse as a
      // `ProcessModel`, since the grammar comes from the provider rather than
      // from anything in the folder.
      const candidates = await head.server.findReferenceCandidates(subjectPickerRequest(head.folderUri('commerce-core')));

      // Both of the project's entities, and only those: `Address` is `public`
      // and `AuditStamp` is not, so a caller inside the project sees its own
      // internal one too. `Money` is a `valuetype`, so the reference type still
      // filters even though nothing here is anchored to a document.
      expect(candidates.map(candidate => candidate.label).sort()).toEqual(['Address', 'AuditStamp']);
   });

   it('walks a synthetic path into a child the new document does not have yet', async () => {
      const head = await driveDataHead();

      // A dialog for a nested element — the effect inside a task — asks about a
      // container chain that exists only in the request. Every hop is synthetic
      // here, so nothing can be read off a document.
      const candidates = await head.server.findReferenceCandidates({
         source: ReferenceSource.synthetic(head.folderUri('orders'), 'ProcessModel'),
         syntheticPath: [SyntheticStep.of('nodes', 'Task', 0), SyntheticStep.of('effects', 'Write', 0)],
         property: 'entity'
      });

      expect(candidates.map(candidate => candidate.label)).toContain('Order');
   });
});
