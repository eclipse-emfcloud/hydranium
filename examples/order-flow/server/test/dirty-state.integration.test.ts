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
import { DocumentState, URI } from '@hydranium/langium';
import { type DataClientProtocol, textHash } from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/testing';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainModel } from '../src/language-server/generated-hydranium/transfer-model.js';
import { makeScratchWorkspaceHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const FILE = 'wire-dirty.domain';
const NEW_FILE = 'wire-dirty-new.domain';
const OTHER_FILE = 'wire-dirty-other.domain';
// A `.process` file: order-flow parses a changed `.domain` file as a project descriptor before the build, so no cancel lands ahead of its parse.
const PROCESS_FILE = 'orders/wire-dirty.process';
const PROCESS_CLEAN = 'process Solo for Order {\n   task A reads Order.id\n}\n';
const PROCESS_EDITED = 'process Solo for Order {\n   task A reads Order.id\n   task B reads Order.id\n}\n';
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

async function boot(
   client?: Partial<DataClientProtocol<DomainModel>>
): Promise<{ head: Harness; uri: string; newUri: string; path: string }> {
   scratch = await makeScratchWorkspaceHarness(workspace => {
      workspace.write(FILE, CLEAN);
      workspace.write(OTHER_FILE, 'entity Other {\n   x : string\n}\n');
      workspace.write(PROCESS_FILE, PROCESS_CLEAN);
   });
   const shared = scratch.harness.shared;
   head = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({
      server: channel => new DataServer<DomainModel>(channel, shared),
      client
   });
   return { head, uri: scratch.workspace.uri(FILE), newUri: scratch.workspace.uri(NEW_FILE), path: scratch.workspace.resolve(FILE) };
}

describe('dirty state over the data head', () => {
   it('answers it on every document, and sends a watcher each change an edit and a save make', async () => {
      const { head, uri, path } = await boot();
      const { proxy, dirtyChanges } = head;
      await proxy.createSession({ clientId: 'form' });

      const opened = await proxy.openModelDocument({ uri, clientId: 'form' });
      await proxy.watchModelDocument({ uri, clientId: 'form' });
      const updated = await proxy.updateModelDocument({ uri, clientId: 'form', model: EDITED, baseVersion: 'any' });
      await waitFor(() => dirtyChanges.length === 1);
      const saved = await proxy.saveModelDocument({ uri, clientId: 'form', model: EDITED, baseVersion: 'any' });

      await waitFor(() => dirtyChanges.length === 2);
      expect([opened.text?.dirty, updated.text?.dirty, saved.text?.dirty]).toEqual([false, true, false]);
      expect(dirtyChanges).toEqual([
         { uri, text: updated.text },
         { uri, text: saved.text }
      ]);
      expect(readFileSync(path, 'utf8')).toBe(EDITED);
   });

   it('sends a watcher the reverted document, then its clean state at that version, when its last close reverts it', async () => {
      const received: string[] = [];
      const { head, uri } = await boot({
         onDocumentUpdated: event => {
            received.push(`update ${event.document.model!.version}`);
         },
         onDocumentDirtyChanged: event => {
            received.push(`dirty ${event.text?.dirty} ${event.text?.version}`);
         }
      });
      const { proxy } = head;
      await proxy.createSession({ clientId: 'form' });
      await proxy.createSession({ clientId: 'tree' });
      await proxy.watchModelDocument({ uri, clientId: 'tree' });
      await proxy.openModelDocument({ uri, clientId: 'form' });
      const updated = await proxy.updateModelDocument({ uri, clientId: 'form', model: EDITED, baseVersion: 'any' });
      await waitFor(
         () => received.includes(`dirty true ${updated.model!.version}`) && received.includes(`update ${updated.model!.version}`)
      );
      received.length = 0;

      await proxy.closeModelDocument({ uri, clientId: 'form' });

      const reverted = updated.model!.version + 1;
      await waitFor(() => received.some(entry => entry.startsWith('dirty')));
      expect(received).toEqual([`update ${reverted}`, `dirty false ${reverted}`]);
   });

   /**
    * Release {@link PROCESS_FILE} dirty while a `tree` session watches it, and have
    * `cancelAt` cancel the revert by scheduling a build of another document, or
    * with `buildsNothing` by a lock write that builds nothing.
    */
   async function releaseDirtyWithCancelledRevert(
      cancelAt: (shared: ScratchOrderFlowHarness['harness']['shared'], uri: string, cancel: () => void) => { dispose(): void },
      buildsNothing = false
   ): Promise<{ flips: string[]; hashes: (string | undefined)[]; cancelled: () => boolean; rootText: () => string | undefined }> {
      const flips: string[] = [];
      const hashes: (string | undefined)[] = [];
      const built: number[] = [];
      const { head } = await boot({
         onDocumentUpdated: event => {
            built.push(event.document.model!.version);
         },
         onDocumentDirtyChanged: event => {
            flips.push(`${event.text?.dirty} v${event.text?.version}`);
            hashes.push(event.text?.hash);
         }
      });
      const shared = scratch!.harness.shared;
      const uri = scratch!.workspace.uri(PROCESS_FILE);
      const { proxy } = head;
      await proxy.createSession({ clientId: 'form' });
      await proxy.createSession({ clientId: 'tree' });
      await proxy.watchModelDocument({ uri, clientId: 'tree' });
      await proxy.openModelDocument({ uri, clientId: 'form' });
      await proxy.updateModelDocument({ uri, clientId: 'form', model: PROCESS_EDITED, baseVersion: 'any' });
      await waitFor(() => flips.length === 1 && built.includes(1));
      let cancelled = false;
      const listener = cancelAt(shared, uri, () => {
         cancelled = true;
         void (buildsNothing
            ? shared.workspace.WorkspaceLock.write(() => undefined)
            : shared.workspace.DocumentBuilder.scheduleUpdate([URI.parse(scratch!.workspace.uri(OTHER_FILE))], []));
      });

      await proxy.closeModelDocument({ uri, clientId: 'form' });
      // Times out without the flip, which the assertion then reports.
      await waitFor(() => flips.length === 2).catch(() => undefined);
      listener.dispose();
      return {
         flips,
         hashes,
         cancelled: () => cancelled,
         rootText: () => shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))?.textDocument.getText()
      };
   }

   it('sends the clean flip of a released dirty document whose revert is cancelled after its parse', async () => {
      let armed = true;
      const released = await releaseDirtyWithCancelledRevert((shared, uri, cancel) =>
         shared.workspace.DocumentBuilder.onDocumentPhase(DocumentState.IndexedContent, document => {
            if (armed && document.uri.toString() === uri) {
               armed = false;
               cancel();
            }
         })
      );

      expect({ cancelled: released.cancelled(), flips: released.flips, hash: released.hashes[1] }).toEqual({
         cancelled: true,
         flips: ['true v1', 'false v2'],
         hash: textHash(PROCESS_CLEAN)
      });
   });

   it('names the file text in the clean flip of a released dirty document whose revert is cancelled before its parse', async () => {
      let armed = true;
      const released = await releaseDirtyWithCancelledRevert((shared, uri, cancel) =>
         shared.workspace.DocumentBuilder.onUpdate(changed => {
            if (armed && changed.some(changedUri => changedUri.toString() === uri)) {
               armed = false;
               cancel();
            }
         })
      );

      expect({ cancelled: released.cancelled(), flips: released.flips, hash: released.hashes[1] }).toEqual({
         cancelled: true,
         flips: ['true v1', 'false v2'],
         hash: textHash(PROCESS_CLEAN)
      });
   });

   it('rebuilds from the file, and sends the clean flip, after a revert cancelled before its parse by a write that builds nothing', async () => {
      let armed = true;
      const released = await releaseDirtyWithCancelledRevert(
         (shared, uri, cancel) =>
            shared.workspace.DocumentBuilder.onUpdate(changed => {
               if (armed && changed.some(changedUri => changedUri.toString() === uri)) {
                  armed = false;
                  cancel();
               }
            }),
         true
      );

      expect({ cancelled: released.cancelled(), flips: released.flips, rootText: released.rootText() }).toEqual({
         cancelled: true,
         flips: ['true v1', 'false v2'],
         rootText: PROCESS_CLEAN
      });
   });

   it('sends the clean flip of a released never-saved document without text', async () => {
      const { head, newUri } = await boot();
      const { proxy, dirtyChanges } = head;
      await proxy.createSession({ clientId: 'form' });
      await proxy.createSession({ clientId: 'tree' });
      await proxy.createModelDocument({ uri: newUri, clientId: 'form', text: CLEAN });
      await proxy.watchModelDocument({ uri: newUri, clientId: 'tree' });

      await proxy.closeModelDocument({ uri: newUri, clientId: 'form' });

      await waitFor(() => dirtyChanges.length === 1);
      expect(dirtyChanges).toEqual([{ uri: newUri }]);
   });

   it('answers a created document dirty until its first save', async () => {
      const { head, newUri } = await boot();
      const { proxy } = head;
      await proxy.createSession({ clientId: 'form' });

      const created = await proxy.createModelDocument({ uri: newUri, clientId: 'form', text: CLEAN });
      const saved = await proxy.saveModelDocument({ uri: newUri, clientId: 'form', model: CLEAN, baseVersion: 'any' });

      expect([created.text?.dirty, saved.text?.dirty]).toEqual([true, false]);
   });
});
