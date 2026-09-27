/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Requests that coincide share one locked build, over a real LSP connection.
 *
 * A session's write reaches the builder twice under LSP: the store's change
 * event dispatches a build through the update handler, and the session
 * rebuilds the document itself. Both go through
 * `HydraniumDocumentBuilder.scheduleUpdate`, so the second joins the first
 * instead of cancelling it. Headless there is no handler, so only the
 * connection shows the pair.
 *
 * The count is of `WorkspaceLock.write` calls, since every cancelled write
 * still runs Langium's `update` prologue and every `onUpdate` listener.
 */

import { NodeFileSystem } from '@hydranium/core/node';
import { makeLspHarness, makeScratchWorkspace, type LspHarness, type ScratchWorkspace } from '@hydranium/core/testing/node';
import { DocumentState, URI } from '@hydranium/langium';
import type { CancellationToken } from 'vscode-languageserver-protocol';
import { waitFor } from '@hydranium/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createOrderFlowServices, type OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';
import { WORKSPACE_ROOT } from './order-flow-harness.js';

const CUSTOMER = 'orders/coalesce-customer.domain';
const ORDER = 'orders/coalesce-order.domain';
const LONE = 'orders/coalesce-lone.domain';
const CUSTOMER_SOURCE = `entity CoalesceCustomer {
   name: string
}
`;
const ORDER_SOURCE = `entity CoalesceOrder {
   customer: CoalesceCustomer
}
`;
const LONE_SOURCE = `entity CoalesceLone {
   id: string
}
`;

let workspace: ScratchWorkspace | undefined;
let lsp: LspHarness | undefined;

afterEach(() => {
   lsp?.dispose();
   lsp = undefined;
   workspace?.dispose();
   workspace = undefined;
});

/** What reached the lock and the builder since the last {@link Recorder.reset}. */
interface Recorder {
   writes: number;
   /** The changed URIs of each `update` call. */
   readonly updates: string[][];
   /** The deleted URIs of each `update` call. */
   readonly deletions: string[][];
   reset(): void;
}

function record(shared: OrderFlowSharedServices): Recorder {
   const recorder: Recorder = {
      writes: 0,
      updates: [],
      deletions: [],
      reset() {
         this.writes = 0;
         this.updates.length = 0;
         this.deletions.length = 0;
      }
   };
   const lock = shared.workspace.WorkspaceLock;
   const write = lock.write.bind(lock);
   lock.write = action => {
      recorder.writes++;
      return write(action);
   };
   const builder = shared.workspace.DocumentBuilder;
   const update = builder.update.bind(builder);
   builder.update = (changed, deleted, cancelToken) => {
      recorder.updates.push(changed.map(uri => uri.toString()).sort());
      recorder.deletions.push(deleted.map(uri => uri.toString()).sort());
      return update(changed, deleted, cancelToken);
   };
   return recorder;
}

async function boot(): Promise<{ shared: OrderFlowSharedServices; uri: (file: string) => string; recorder: Recorder }> {
   const root = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-coalesce-' });
   workspace = root;
   root.write(CUSTOMER, CUSTOMER_SOURCE);
   root.write(ORDER, ORDER_SOURCE);
   root.write(LONE, LONE_SOURCE);
   let booted: OrderFlowSharedServices | undefined;
   const harness = makeLspHarness({
      createServices: connection => {
         booted = createOrderFlowServices({ connection, ...NodeFileSystem }).shared;
         return booted;
      }
   });
   lsp = harness;
   await harness.initialize({ workspaceFolders: [{ uri: root.uri(), name: 'order-flow' }] });
   const shared = booted!;
   return {
      shared,
      uri: file => shared.workspace.DocumentUriPolicy.canonicalUri(root.uri(file)),
      recorder: record(shared)
   };
}

/** Resolves once no write runs or is queued: a read waits for every write. */
function idle(shared: OrderFlowSharedServices): Promise<void> {
   return shared.workspace.WorkspaceLock.read(() => undefined);
}

/**
 * Hold the next build at its `Parsed` phase until its token is cancelled or
 * {@link Hold.release} runs. `reached` resolves once the build is held.
 */
interface Hold {
   readonly reached: Promise<void>;
   readonly cancelled: () => boolean;
   release(): void;
}

function holdNextBuild(shared: OrderFlowSharedServices): Hold {
   let reach!: () => void;
   let release!: () => void;
   let heldToken: CancellationToken | undefined;
   const reached = new Promise<void>(resolve => (reach = resolve));
   const released = new Promise<void>(resolve => (release = resolve));
   const listener = shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.Parsed, async (_documents, cancelToken) => {
      listener.dispose();
      heldToken = cancelToken;
      reach();
      await new Promise<void>(resolve => {
         const subscription = cancelToken.onCancellationRequested(resolve);
         void released.then(() => {
            subscription.dispose();
            resolve();
         });
      });
   });
   return { reached, cancelled: () => heldToken?.isCancellationRequested === true, release };
}

/** The text `uri`'s AST was parsed from, rather than the text store's. */
function parsedText(shared: OrderFlowSharedServices, uri: string): string | undefined {
   return shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))?.parseResult.value.$cstNode?.root.fullText;
}

describe('requests that coincide share one locked build', () => {
   it('a session write takes one lock write, not one for the handler and one for the session', async () => {
      const { shared, uri, recorder } = await boot();
      const models = shared.model.ModelService;
      const writer = models.createSession('writer', 'writer');
      await writer.open(uri(ORDER));
      await models.validated(uri(ORDER));
      await idle(shared);
      recorder.reset();

      for (const edit of ['one', 'two', 'three']) {
         await writer.update({ uri: uri(ORDER), model: `${ORDER_SOURCE}// ${edit}\n`, basedOn: 'anything' });
      }
      await idle(shared);

      expect(recorder.writes).toBe(3);
      expect(recorder.updates).toEqual([[uri(ORDER)], [uri(ORDER)], [uri(ORDER)]]);
   });

   it('an updateAll of two documents takes one lock write, whose build carries both', async () => {
      const { shared, uri, recorder } = await boot();
      const models = shared.model.ModelService;
      const writer = models.createSession('writer', 'writer');
      await writer.open(uri(CUSTOMER));
      await writer.open(uri(LONE));
      await models.validated(uri(CUSTOMER));
      await models.validated(uri(LONE));
      await idle(shared);
      recorder.reset();

      await writer.updateAll({
         updates: [
            { uri: uri(CUSTOMER), model: `${CUSTOMER_SOURCE}// customer\n`, basedOn: 'anything' },
            { uri: uri(LONE), model: `${LONE_SOURCE}// lone\n`, basedOn: 'anything' }
         ]
      });
      await idle(shared);

      expect(recorder.writes).toBe(1);
      expect(recorder.updates).toEqual([[uri(CUSTOMER), uri(LONE)].sort()]);
   });

   it('two sessions writing at once share one build', async () => {
      const { shared, uri, recorder } = await boot();
      const models = shared.model.ModelService;
      const one = models.createSession('one', 'one');
      const two = models.createSession('two', 'two');
      await one.open(uri(CUSTOMER));
      await two.open(uri(LONE));
      await models.validated(uri(CUSTOMER));
      await models.validated(uri(LONE));
      await idle(shared);
      recorder.reset();

      await Promise.all([
         one.update({ uri: uri(CUSTOMER), model: `${CUSTOMER_SOURCE}// one\n`, basedOn: 'anything' }),
         two.update({ uri: uri(LONE), model: `${LONE_SOURCE}// two\n`, basedOn: 'anything' })
      ]);
      await idle(shared);

      expect(recorder.writes).toBe(1);
      expect(recorder.updates).toEqual([[uri(CUSTOMER), uri(LONE)].sort()]);
   });

   it('identical rebuilds while the build runs join it', async () => {
      const { shared, uri, recorder } = await boot();
      const models = shared.model.ModelService;
      const writer = models.createSession('writer', 'writer');
      await writer.open(uri(ORDER));
      await models.validated(uri(ORDER));
      await idle(shared);
      recorder.reset();

      const hold = holdNextBuild(shared);
      const written = writer.update({ uri: uri(ORDER), model: `${ORDER_SOURCE}// held\n`, basedOn: 'anything' });
      await hold.reached;
      const rebuilt = [models.rebuild(uri(ORDER)), models.rebuild(uri(ORDER))];
      hold.release();
      await Promise.all([written, ...rebuilt]);
      await idle(shared);

      expect(hold.cancelled()).toBe(false);
      expect(recorder.writes).toBe(1);
   });

   it('an editor edit while the build runs still cancels it, and the next build parses the edit', async () => {
      const { shared, uri, recorder } = await boot();
      const models = shared.model.ModelService;
      const writer = models.createSession('writer', 'writer');
      lsp!.openDocument(uri(ORDER), ORDER_SOURCE, 'domain', 1);
      await writer.open(uri(ORDER));
      await models.validated(uri(ORDER));
      await idle(shared);
      recorder.reset();

      const hold = holdNextBuild(shared);
      const written = writer.update({ uri: uri(ORDER), model: `${ORDER_SOURCE}// session\n`, basedOn: 'anything' });
      await hold.reached;
      lsp!.changeDocument(uri(ORDER), `${ORDER_SOURCE}// session\n// typed\n`, 2);
      try {
         await waitFor(() => hold.cancelled(), { message: 'the edit never cancelled the held build' });
      } finally {
         hold.release();
      }
      await written;
      await models.validated(uri(ORDER));
      await idle(shared);

      expect(recorder.writes).toBe(2);
      expect(parsedText(shared, uri(ORDER))).toContain('// typed');
   });

   it('a request after another write cancelled the queued build queues a write of its own', async () => {
      const { shared, uri, recorder } = await boot();
      const models = shared.model.ModelService;
      const builder = shared.workspace.DocumentBuilder;
      const lock = shared.workspace.WorkspaceLock;
      // Waits once the initial build is done: armed while it runs, a wait for
      // a document that build leaves unvalidated waits for some later build,
      // since the initial build's empty Validated phase notifies nobody.
      await idle(shared);
      await models.validated(uri(CUSTOMER));
      await models.validated(uri(LONE));
      await idle(shared);
      recorder.reset();

      // A build held at `Parsed` keeps the next scheduled request queued.
      const hold = holdNextBuild(shared);
      const running = builder.scheduleUpdate([URI.parse(uri(ORDER))], []);
      await hold.reached;
      const queued = builder.scheduleUpdate([URI.parse(uri(LONE))], []);
      // Nothing to build: a write of its own that cancels the queued one.
      const outside = lock.write(() => undefined);
      const after = builder.scheduleUpdate([URI.parse(uri(CUSTOMER))], []);
      hold.release();
      await Promise.all([running, queued, outside, after]);
      await idle(shared);

      expect(recorder.writes).toBe(4);
      expect(recorder.updates.at(-1)).toEqual([uri(CUSTOMER)]);
   });

   it('a change merged after a deletion of the same URI undoes the deletion', async () => {
      // A file deleted and written again before the queued build starts, as an
      // atomic save does. Both lists would reach every `onUpdate` listener, which
      // would treat a file that exists as gone.
      const { shared, uri, recorder } = await boot();
      const builder = shared.workspace.DocumentBuilder;
      await idle(shared);
      await shared.model.ModelService.validated(uri(LONE));
      await idle(shared);
      recorder.reset();

      const hold = holdNextBuild(shared);
      const running = builder.scheduleUpdate([URI.parse(uri(ORDER))], []);
      await hold.reached;
      const deletion = builder.scheduleUpdate([], [URI.parse(uri(LONE))]);
      const recreation = builder.scheduleUpdate([URI.parse(uri(LONE))], []);
      hold.release();
      await Promise.all([running, deletion, recreation]);
      await idle(shared);

      expect(recorder.writes).toBe(2);
      expect(recorder.updates.at(-1)).toEqual([uri(LONE)]);
      expect(recorder.deletions.at(-1)).toEqual([]);
   });

   it('a deletion merged after a change of the same URI wins', async () => {
      const { shared, uri, recorder } = await boot();
      const builder = shared.workspace.DocumentBuilder;
      await idle(shared);
      await shared.model.ModelService.validated(uri(LONE));
      await idle(shared);
      recorder.reset();

      const hold = holdNextBuild(shared);
      const running = builder.scheduleUpdate([URI.parse(uri(ORDER))], []);
      await hold.reached;
      const change = builder.scheduleUpdate([URI.parse(uri(LONE))], []);
      const deletion = builder.scheduleUpdate([], [URI.parse(uri(LONE))]);
      hold.release();
      await Promise.all([running, change, deletion]);
      await idle(shared);

      expect(recorder.writes).toBe(2);
      expect(recorder.updates.at(-1)).toEqual([]);
      expect(recorder.deletions.at(-1)).toEqual([uri(LONE)]);
   });
});
