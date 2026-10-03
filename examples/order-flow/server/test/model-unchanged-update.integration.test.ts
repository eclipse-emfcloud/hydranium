/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Update events for an edit that changes a document's text but not its
 * transfer model, over the data head's wire against the real stack: the new
 * version still reaches a watcher, marked so it can skip reading the root.
 */

import { DataServer } from '@hydranium/data-server';
import { DocumentState } from '@hydranium/langium';
import { makeDataServerHarness, type DataServerHarness } from '@hydranium/data-server/testing';
import { waitFor } from '@hydranium/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainModel } from '../src/language-server/generated-hydranium/transfer-model.js';
import { makeScratchWorkspaceHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const FILE = 'model-unchanged.domain';
const CLEAN = 'entity Solo {\n   a : string\n}\n';
const COMMENTED = `${CLEAN}// a comment\n`;
const EDITED = 'entity Solo {\n   a : string\n   b : string\n}\n';

type Harness = DataServerHarness<DataServer<DomainModel>, DomainModel>;

let scratch: ScratchOrderFlowHarness | undefined;
let head: Harness | undefined;

afterEach(() => {
   head?.dispose();
   head = undefined;
   scratch?.workspace.dispose();
   scratch = undefined;
});

/** A head with a `writer` session that has {@link FILE} open and a `watcher` session watching it, validated. */
async function boot(): Promise<{ head: Harness; uri: string; opened: number; shared: ScratchOrderFlowHarness['harness']['shared'] }> {
   scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, CLEAN));
   const shared = scratch.harness.shared;
   head = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({ server: channel => new DataServer<DomainModel>(channel, shared) });
   const uri = scratch.workspace.uri(FILE);
   await head.proxy.createSession({ clientId: 'writer' });
   await head.proxy.createSession({ clientId: 'watcher' });
   const opened = await head.proxy.openModelDocument({ uri, clientId: 'writer' });
   // Validated before the watch, so its baseline already holds the diagnostics
   // and the only change the edits below make is their own.
   await head.proxy.getModelDocument({ uri, includeDiagnostics: true });
   await head.proxy.watchModelDocument({ uri, clientId: 'watcher' });
   return { head, uri, opened: opened.version, shared };
}

describe('an edit that leaves the transfer model unchanged', () => {
   it('reaches a watcher at its new version, marked as leaving the model unchanged', async () => {
      const { head, uri, opened } = await boot();

      const written = await head.proxy.updateModelDocument({ uri, clientId: 'writer', model: COMMENTED, basedOn: 'anything' });

      await waitFor(() => head.events.length === 1, { message: 'no update event for the comment-only edit' });
      const [event] = head.events;
      expect({ version: event.document.version, reason: event.reason, modelUnchanged: event.modelUnchanged }).toEqual({
         version: written.version,
         reason: 'changed',
         modelUnchanged: true
      });
      expect(written.version).not.toBe(opened);
   });

   it('sends an edit that changes the model without the mark', async () => {
      const { head, uri } = await boot();

      await head.proxy.updateModelDocument({ uri, clientId: 'writer', model: EDITED, basedOn: 'anything' });

      await waitFor(() => head.events.length === 1, { message: 'no update event for the model edit' });
      expect(head.events[0].modelUnchanged).toBeUndefined();
   });

   it('sends nothing for a rebuild at the version the watcher already has', async () => {
      const { head, uri, shared } = await boot();

      await shared.model.ModelService.rebuild(uri, DocumentState.Validated);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(head.events).toEqual([]);
   });
});
