/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it, vi } from 'vitest';
import { Deferred, type TransferDiagnostic } from '@hydranium/protocol';
import { makeTestServices, type TestServicesBundle } from '@hydranium/core/testing';
import type { AstDiagnostic } from '@hydranium/core';
import { DataServer } from '../src/data-server.js';
import { nodeDataServerDiagnostics } from '../src/node/node-diagnostics-provider.js';
import { makeDataServerHarness } from '../src/testing/data-server-harness.js';

interface FakeRoot {
   readonly $type: 'FakeRoot';
   readonly name: string;
}

type Bundle = TestServicesBundle<FakeRoot & { $type: string }, AstDiagnostic, FakeRoot>;

/** Exposes who watches a URI. */
class WatchProbeServer extends DataServer<FakeRoot, TransferDiagnostic> {
   watchersOf(uri: string): string[] {
      return [...(this.uriWatchRecords.get(this.canonicalKey(uri))?.watchers ?? [])];
   }
}

const URI_A = 'file:///workspace/A.fake';
const CLIENT = 'opening';

type Harness = ReturnType<typeof harnessOf>;

function harnessOf(bundle: Bundle) {
   return makeDataServerHarness<WatchProbeServer, FakeRoot, TransferDiagnostic>({
      server: channel => new WatchProbeServer(channel, bundle.services, { diagnostics: nodeDataServerDiagnostics() })
   });
}

type Gate = 'registration' | 'read';

/**
 * Hold the gated step of the next open until `release` settles it, failing
 * it then when `fails` is set.
 */
function hold(bundle: Bundle, gate: Gate, fails: boolean): { reached: Promise<void>; release: () => void } {
   const reached = new Deferred<void>();
   const released = new Deferred<void>();
   if (gate === 'registration') {
      const manager = bundle.astDocumentManager;
      const open = manager.open.bind(manager);
      vi.spyOn(manager, 'open').mockImplementationOnce(async args => {
         reached.resolve();
         await released.promise;
         if (fails) {
            throw new Error('registration failed');
         }
         return open(args);
      });
   } else {
      const modelService = bundle.services.model.ModelService;
      const ensure = modelService.ensureDocumentState.bind(modelService);
      vi.spyOn(modelService, 'ensureDocumentState').mockImplementationOnce(async (uri, state) => {
         reached.resolve();
         await released.promise;
         if (fails) {
            throw new Error('read failed');
         }
         return ensure(uri, state);
      });
   }
   return { reached: reached.promise, release: () => released.resolve() };
}

interface Interruption {
   readonly name: string;
   readonly gates: readonly Gate[];
   run(harness: Harness, bundle: Bundle): Promise<unknown>;
   /** Who holds the document, where the stub store tracks it, and who watches it once every request settled. */
   readonly expected: (gate: Gate, fails: boolean) => { opens?: string[]; watchers: string[] };
}

const none = { opens: [], watchers: [] };
const held = { opens: [CLIENT], watchers: [] };

const close = (harness: Harness): Promise<void> => harness.proxy.closeModelDocument({ uri: URI_A, clientId: CLIENT });

const INTERRUPTIONS: readonly Interruption[] = [
   {
      name: 'nothing',
      gates: ['registration', 'read'],
      run: async () => undefined,
      expected: (_gate, fails) => (fails ? none : { opens: [CLIENT], watchers: [CLIENT] })
   },
   {
      name: 'a close',
      gates: ['registration', 'read'],
      run: close,
      // The store closes nothing it has yet to open, so the client closes it again once answered, as on main.
      expected: (gate, fails) => (gate === 'registration' && !fails ? held : none)
   },
   {
      name: 'a close and an unwatched open',
      gates: ['registration', 'read'],
      run: async harness => {
         await close(harness);
         return harness.proxy.openModelDocument({ uri: URI_A, clientId: CLIENT });
      },
      expected: () => held
   },
   {
      name: 'a close and a watched open',
      gates: ['registration', 'read'],
      run: async harness => {
         await close(harness);
         return harness.proxy.openModelDocument({ uri: URI_A, clientId: CLIENT, watch: true });
      },
      expected: () => ({ opens: [CLIENT], watchers: [CLIENT] })
   },
   {
      name: 'a deletion',
      gates: ['read'],
      run: async (_harness, bundle) => {
         bundle.documents.clear();
         bundle.astDocumentManager.openClients.get(URI_A)?.delete(CLIENT);
         bundle.textDocuments.fireClose(URI_A, CLIENT);
      },
      expected: () => none
   },
   {
      name: 'the session end',
      gates: ['registration', 'read'],
      run: harness => harness.proxy.closeSession({ clientId: CLIENT }),
      // The stub store's session end leaves its opens.
      expected: () => ({ watchers: [] })
   }
];

// The stub store cannot create, so creates are left to the integration suites.
const CASES = INTERRUPTIONS.flatMap(interruption =>
   interruption.gates.flatMap(gate =>
      [false, true].map(fails => [gate, interruption.name, fails ? 'fails' : 'succeeds', interruption, fails] as const)
   )
);

describe('DataServer opens interrupted at each await', () => {
   it.each(CASES)(
      'a watched open held at its %s, interrupted by %s, whose step then %s',
      async (gate, _name, _outcome, interruption, fails) => {
         const bundle = makeTestServices<FakeRoot & { $type: string }, AstDiagnostic, FakeRoot>({
            serialize: (_uri, root) => `name:${root.name}`
         });
         bundle.documents.set(URI_A, { $type: 'FakeRoot', name: 'A' });
         const gated = hold(bundle, gate, fails);
         const harness = harnessOf(bundle);
         const { server, proxy, pair } = harness;
         try {
            await proxy.createSession({ clientId: CLIENT });
            const first = proxy.openModelDocument({ uri: URI_A, clientId: CLIENT, watch: true });
            await gated.reached;
            const later = interruption.run(harness, bundle);
            // Answered after every request before it began, as the connection keeps order.
            await proxy.createSession({ clientId: 'barrier' });
            gated.release();
            await Promise.allSettled([first, later]);

            const expected = interruption.expected(gate, fails);
            const opens = [...(bundle.astDocumentManager.openClients.get(URI_A) ?? [])];
            expect({ ...(expected.opens ? { opens } : {}), watchers: server.watchersOf(URI_A) }).toEqual(expected);
         } finally {
            pair.dispose();
         }
      }
   );
});
