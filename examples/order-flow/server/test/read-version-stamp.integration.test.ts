/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A read over the data head while an editor's change waits out the debounce,
 * over the real LSP wire: the built document still holds the previous root
 * while the store's text document, which it shares, already has the new text.
 *
 * The update handler debounces for a minute, so the change stays unbuilt for
 * the whole test.
 */

import type { ServerSharedServices } from '@hydranium/core';
import { HydraniumDocumentUpdateHandler } from '@hydranium/core/lsp';
import { NodeFileSystem } from '@hydranium/core/node';
import {
   type LspHarness,
   makeLspHarness,
   makeLspServerConnection,
   makeScratchWorkspace,
   type ScratchWorkspace
} from '@hydranium/core/testing/node';
import { DataServer } from '@hydranium/data-server';
import { type DataServerHarness, makeDataServerHarness } from '@hydranium/data-server/testing';
import { isConflictError, NO_MATCHING_VERSION, type TransferDocument } from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainModel } from '../src/language-server/generated-hydranium/transfer-model.js';
import { createOrderFlowServices } from '../src/language-server/order-flow-module.js';
import { WORKSPACE_ROOT } from './order-flow-harness.js';

const FILE = 'read-version-stamp.domain';
const CLEAN = 'entity Solo {\n   a : string\n}\n';
const EDITED = 'entity Solo {\n   a : string\n   b : string\n}\n';

type Head = DataServerHarness<DataServer<DomainModel>, DomainModel>;

let workspace: ScratchWorkspace | undefined;
let lsp: LspHarness | undefined;
let head: Head | undefined;

afterEach(() => {
   head?.dispose();
   head = undefined;
   lsp?.dispose();
   lsp = undefined;
   workspace?.dispose();
   workspace = undefined;
});

/**
 * Open {@link FILE} in the editor and through a watching `form` session, then
 * change it in the editor and read it while the change is unbuilt.
 */
async function readDuringDebounce(): Promise<{
   head: Head;
   services: ReturnType<typeof createOrderFlowServices>;
   uri: string;
   read: TransferDocument<DomainModel>;
}> {
   workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-read-version-' });
   workspace.write(FILE, CLEAN);
   const uri = workspace.uri(FILE);
   const wire = makeLspServerConnection();
   const services = createOrderFlowServices(
      { ...NodeFileSystem, connection: wire.serverConnection },
      {
         extraSharedModules: [
            {
               lsp: {
                  DocumentUpdateHandler: (shared: ServerSharedServices) =>
                     new HydraniumDocumentUpdateHandler(shared, { debounceMs: 60_000 })
               }
            }
         ]
      }
   );
   lsp = makeLspHarness({ connection: wire, services: services.shared });
   await lsp.initialize({ workspaceFolders: [{ uri: workspace.uri(), name: 'order-flow' }] });
   head = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({
      server: channel => new DataServer<DomainModel>(channel, services.shared)
   });
   const store = services.shared.workspace.TextDocuments;
   await head.proxy.createSession({ clientId: 'form' });

   lsp.openDocument(uri, CLEAN, 'order-flow-domain', 1);
   await waitFor(() => store.get(uri)?.getText() === CLEAN, { timeoutMs: 2000 });
   await head.proxy.openModelDocument({ uri, clientId: 'form' });
   await head.proxy.watchModelDocument({ uri, clientId: 'form' });
   lsp.changeDocument(uri, EDITED, 2);
   await waitFor(() => store.get(uri)?.getText() === EDITED, { timeoutMs: 2000 });

   return { head, services, uri, read: await head.proxy.getModelDocument({ uri }) };
}

describe('a read while an editor change is debounced', () => {
   it('answers the previous root with a version no write matches', async () => {
      const { read } = await readDuringDebounce();

      expect({ holdsEdit: JSON.stringify(read.root).includes('"b"'), version: read.version }).toEqual({
         holdsEdit: false,
         version: NO_MATCHING_VERSION
      });
   });

   it('rejects a gated write of that read instead of dropping the edit', async () => {
      const { head, services, uri, read } = await readDuringDebounce();

      const error = await head.proxy.updateModelDocument({ uri, clientId: 'form', model: read.root!, basedOn: read.version }).then(
         () => undefined,
         (rejection: unknown) => rejection
      );

      expect({ conflict: isConflictError(error), text: services.shared.workspace.TextDocuments.get(uri)?.getText() }).toEqual({
         conflict: true,
         text: EDITED
      });
   });

   it("flips dirty at the edit's version, ahead of the read, and the update at that version follows", async () => {
      const { head, services, uri, read } = await readDuringDebounce();
      await waitFor(() => head.dirtyChanges.length > 0, { timeoutMs: 2000 });
      const flip = head.dirtyChanges.at(-1)!;

      expect({ dirty: flip.dirty, version: flip.version, read: read.version }).toEqual({
         dirty: true,
         version: services.shared.workspace.TextDocuments.version(uri),
         read: NO_MATCHING_VERSION
      });
      services.shared.lsp.DocumentUpdateHandler.flushPending();
      await waitFor(() => head.events.some(event => event.document.version === flip.version), {
         timeoutMs: 2000,
         message: "no update at the flip's version"
      });
   });
});
