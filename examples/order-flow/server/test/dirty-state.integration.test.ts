/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A document's dirty state over the data head's wire, against the real stack:
 * the answer on every document the head sends, and its changes on the watch.
 */

import { DataServer } from '@hydranium/data-server';
import { makeDataServerHarness, type DataServerHarness } from '@hydranium/data-server/testing';
import { waitFor } from '@hydranium/protocol/testing';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainModel } from '../src/language-server/generated-hydranium/transfer-model.js';
import { makeScratchWorkspaceHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const FILE = 'wire-dirty.domain';
const NEW_FILE = 'wire-dirty-new.domain';
const CLEAN = `entity Solo {
   a : string
}
`;
const EDITED = `entity Solo {
   a : string
   b : string
}
`;

type Harness = DataServerHarness<DataServer<DomainModel>, DomainModel>;

let scratch: ScratchOrderFlowHarness | undefined;
let head: Harness | undefined;

afterEach(() => {
   head?.dispose();
   head = undefined;
   scratch?.workspace.dispose();
   scratch = undefined;
});

async function boot(): Promise<{ head: Harness; uri: string; newUri: string; path: string }> {
   scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, CLEAN));
   const shared = scratch.harness.shared;
   head = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({ server: channel => new DataServer<DomainModel>(channel, shared) });
   return { head, uri: scratch.workspace.uri(FILE), newUri: scratch.workspace.uri(NEW_FILE), path: scratch.workspace.resolve(FILE) };
}

describe('dirty state over the data head', () => {
   it('answers it on every document, and sends a watcher each change an edit and a save make', async () => {
      const { head, uri, path } = await boot();
      const { proxy, dirtyChanges } = head;
      await proxy.createSession({ clientId: 'form' });

      const opened = await proxy.openModelDocument({ uri, clientId: 'form' });
      await proxy.watchModelDocument({ uri, clientId: 'form' });
      const updated = await proxy.updateModelDocument({ uri, clientId: 'form', model: EDITED, basedOn: 'anything' });
      await waitFor(() => dirtyChanges.length === 1);
      const saved = await proxy.saveModelDocument({ uri, clientId: 'form', model: EDITED, basedOn: 'anything' });

      await waitFor(() => dirtyChanges.length === 2);
      expect([opened.dirty, updated.dirty, saved.dirty]).toEqual([false, true, false]);
      expect(dirtyChanges).toEqual([
         { uri, dirty: true },
         { uri, dirty: false }
      ]);
      expect(readFileSync(path, 'utf8')).toBe(EDITED);
   });

   it('sends a watcher the clean state of a dirty document its last close reverts', async () => {
      const { head, uri } = await boot();
      const { proxy, dirtyChanges } = head;
      await proxy.createSession({ clientId: 'form' });
      await proxy.createSession({ clientId: 'tree' });
      await proxy.watchModelDocument({ uri, clientId: 'tree' });
      await proxy.openModelDocument({ uri, clientId: 'form' });
      await proxy.updateModelDocument({ uri, clientId: 'form', model: EDITED, basedOn: 'anything' });
      await waitFor(() => dirtyChanges.length === 1);

      await proxy.closeModelDocument({ uri, clientId: 'form' });

      await waitFor(() => dirtyChanges.length === 2);
      expect(dirtyChanges[1]).toEqual({ uri, dirty: false });
   });

   it('answers a created document dirty until its first save', async () => {
      const { head, newUri } = await boot();
      const { proxy } = head;
      await proxy.createSession({ clientId: 'form' });

      const created = await proxy.createModelDocument({ uri: newUri, clientId: 'form', text: CLEAN });
      const saved = await proxy.saveModelDocument({ uri: newUri, clientId: 'form', model: CLEAN, basedOn: 'anything' });

      expect([created.dirty, saved.dirty]).toEqual([true, false]);
   });
});
