/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Type-contract smoke tests for `@hydranium/protocol/data`. The load-bearing
 * half is the compile step — if the protocol surface drifts in a way that
 * breaks adopter implementations or violates the documented invariants, the
 * file fails to typecheck and the runtime assertions are never reached.
 *
 * They live in server-core rather than beside the protocol package's own suite
 * because the fake implementation is built with `makeFakeAstNode` from
 * `@hydranium/core/testing`, and protocol cannot depend on core without
 * inverting the package graph.
 */

import { describe, expect, it } from 'vitest';
import {
   DATA_SERVER_PATH,
   DATA_SERVER_PROTOCOL_METHODS,
   DATA_SERVER_WIRE_PREFIX,
   type DataServerProtocol,
   type GetModelDocumentArgs,
   type GetProjectForUriArgs,
   type TransferSaveDocumentArgs,
   type WatchModelDocumentArgs,
   type TransferDocumentSavedEvent,
   type TransferDocumentUpdateReason,
   type TransferUpdateDocumentArgs
} from '@hydranium/protocol/data';
import { type CloseModelArgs, type OpenModelArgs, type Project, TransferDocument } from '@hydranium/protocol';
import { makeFakeAstNode } from '../../src/testing/index.js';

/** A minimal fake transfer root standing in for a real grammar's generated wire root type. */
interface FakeRoot {
   readonly $type: 'FakeRoot';
   readonly name: string;
}

const FakeRoot = {
   make(name: string): FakeRoot {
      return makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name });
   }
};

/** Helper that synthesises a `TransferDocument<FakeRoot>` for the fake-impl factories. */
function makeDocument(uri: string, root: FakeRoot): TransferDocument<FakeRoot> {
   return TransferDocument.create<FakeRoot>(uri, 1, root);
}

/**
 * A reference fake `DataServerProtocol<FakeRoot>` implementation. Declaring it
 * is itself the assertion: it only typechecks while every method signature
 * still binds against a custom AST root.
 */
function makeFakeProtocol(): DataServerProtocol<FakeRoot> {
   return {
      async openModelDocument(args: OpenModelArgs) {
         return makeDocument(args.uri, FakeRoot.make('opened'));
      },
      async closeModelDocument(_args: CloseModelArgs) {
         // Counterpart to openModelDocument — no-op in the fake.
      },
      async getModelDocument(args: GetModelDocumentArgs) {
         return makeDocument(args.uri, FakeRoot.make('queried'));
      },
      async updateModelDocument(args: TransferUpdateDocumentArgs<FakeRoot>) {
         const root = typeof args.model === 'string' ? FakeRoot.make(args.model) : args.model;
         return makeDocument(args.uri, root);
      },
      async saveModelDocument(args: TransferSaveDocumentArgs<FakeRoot>) {
         const root = typeof args.model === 'string' ? FakeRoot.make(args.model) : args.model;
         return makeDocument(args.uri, root);
      },
      async watchModelDocument(_args: WatchModelDocumentArgs) {
         // Nothing to return: a watch is a dispatch-table entry, not a handle.
      },
      async unwatchModelDocument(_args: WatchModelDocumentArgs) {
         // Pairs with watchModelDocument — idempotent teardown.
      },
      async getProjects() {
         const projects: readonly Project[] = [{ id: 'fake', referenceName: 'fake', version: '1.0.0' }];
         return projects;
      },
      async getProjectForUri(_args: GetProjectForUriArgs) {
         return { id: 'fake', referenceName: 'fake', version: '1.0.0' };
      },
      async waitForReady() {
         // The real `DataServer` awaits its model service's readiness; the fake
         // holds no workspace, so there is nothing to wait for.
      }
   };
}

describe('DataServerProtocol — type contract', () => {
   it('compiles a fake implementation against a custom AST root', async () => {
      const protocol = makeFakeProtocol();
      const doc = await protocol.getModelDocument({ uri: 'fake://doc' });
      expect(doc.root?.$type).toBe('FakeRoot');
      expect(doc.diagnostics).toEqual([]);
   });

   it('accepts both structured and string `model` payloads', async () => {
      const protocol = makeFakeProtocol();
      const fromString = await protocol.updateModelDocument({
         uri: 'fake://doc',
         clientId: 'test',
         model: 'serialised'
      });
      const fromStruct = await protocol.updateModelDocument({
         uri: 'fake://doc',
         clientId: 'test',
         model: FakeRoot.make('structured')
      });
      expect(fromString.root?.name).toBe('serialised');
      expect(fromStruct.root?.name).toBe('structured');
   });

   it('watchModelDocument / unwatchModelDocument are void-returning by contract', async () => {
      // The wire-level watch contract is dispatch-table registration — events
      // flow through `DataClientProtocol.onDocumentUpdated` on the paired wire,
      // not through a returned handle. The protocol-level test only verifies the
      // type plumbing: both methods accept WatchModelDocumentArgs and return Promise<void>.
      const protocol = makeFakeProtocol();
      // `expect(await …).toBeUndefined()` would assert against the empty method
      // bodies THIS FILE wrote, not against the declaration. The discriminating
      // assertions are the two below: each stops compiling the moment the
      // declared return widens past `Promise<void>` into a handle a client would
      // have to dispose.
      // @ts-expect-error — the watch contract returns no handle.
      const watchHandle: { dispose(): void } = await protocol.watchModelDocument({ uri: 'fake://doc', clientId: 'test' });
      // @ts-expect-error — nor does its teardown counterpart.
      const unwatchHandle: { dispose(): void } = await protocol.unwatchModelDocument({ uri: 'fake://doc', clientId: 'test' });
      expect(watchHandle).toBeUndefined();
      expect(unwatchHandle).toBeUndefined();
   });

   it('exposes the `TransferDocumentUpdateReason` union exhaustively', () => {
      // A `readonly TransferDocumentUpdateReason[]` literal plus `toHaveLength(4)`
      // catches NARROWING only: an array of four names still typechecks and still
      // has length 4 after a FIFTH member is added, which is the drift that
      // matters to a subscriber's `switch`. A total `Record` keyed by the union
      // fails to compile in BOTH directions — a missing key for a new member, an
      // excess key for a removed one — and `typecheck:test` is the gate that runs
      // it (a bare `vitest run` does not typecheck).
      const REASON_COVERAGE: Record<TransferDocumentUpdateReason, true> = {
         changed: true,
         rebuilt: true,
         saved: true,
         deleted: true
      };
      expect(Object.keys(REASON_COVERAGE).sort()).toEqual(['changed', 'deleted', 'rebuilt', 'saved']);
   });

   it('keeps `TransferDocumentSavedEvent` distinct from update events', () => {
      // Both event types share the `document` + `sourceClientId` shape but the saved
      // event has no `reason` discriminator — keeping them as separate event families
      // lets subscribers listen narrowly without filtering an update stream.
      const saved: TransferDocumentSavedEvent<FakeRoot> = {
         document: makeDocument('fake://doc', FakeRoot.make('post-save')),
         sourceClientId: 'test'
      };
      // `'reason' in saved` on a literal written without that key can never be
      // true, whatever the type says. The load-bearing assertion is the one
      // below: it fails to compile the moment `reason` becomes assignable, i.e.
      // the moment the two event families stop being distinct.
      const withReason: TransferDocumentSavedEvent<FakeRoot> = {
         document: makeDocument('fake://doc', FakeRoot.make('post-save')),
         sourceClientId: 'test',
         // @ts-expect-error — a saved event carries no `reason` discriminator.
         reason: 'saved'
      };
      expect(saved.sourceClientId).toBe(withReason.sourceClientId);
   });
});

describe('DATA_SERVER_PROTOCOL_METHODS + DATA_SERVER_PATH — wire constants', () => {
   it('exposes a stable path identifier', () => {
      expect(DATA_SERVER_PATH).toBe('/hydranium/data-server');
   });

   it('lists exactly the request methods on DataServerProtocol — array must not drift from the interface', () => {
      // Cross-checks both directions: every method in the array must be on the
      // interface (caught at compile time by the `as const satisfies` on the
      // array declaration), and every method on the interface must be in the
      // array (checked here at runtime, so adding a method to
      // `DataServerProtocol` without updating the array breaks this test).
      // Drift in either direction breaks the wire contract.
      const interfaceMethods = Object.keys(makeFakeProtocol()).sort() as Array<keyof DataServerProtocol<FakeRoot>>;
      const arrayMethods = [...DATA_SERVER_PROTOCOL_METHODS].sort();
      expect(arrayMethods).toEqual(interfaceMethods);
   });

   it('derives every wire name as DATA_SERVER_WIRE_PREFIX + methodName', () => {
      for (const method of DATA_SERVER_PROTOCOL_METHODS) {
         const wireName = DATA_SERVER_WIRE_PREFIX + method;
         expect(wireName.startsWith('data-server/')).toBe(true);
      }
   });
});
