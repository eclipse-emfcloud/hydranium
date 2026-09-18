/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What `DataConnection`'s type parameters admit and refuse.
 *
 * The guarantees are type-level, so `typecheck:test` is what runs them — a
 * separate turbo task from `build`, which does not typecheck tests. Each
 * assertion is a `@ts-expect-error`, and an UNUSED one is itself an error, so a
 * clean compile proves every one of them fired.
 *
 * The assertions live in a function nothing calls, because constructing a
 * connection needs a live port and none of this is meant to run.
 */

import { describe, expect, it } from 'vitest';
import { DataConnection, DataConnectionWithEvents } from '../../src/client/data-connection';
import type { DataPort } from '../../src/client/data-port';
import type { DataClientProtocol, DataServerProtocol } from '../../src/data';
import type { Project } from '../../src/project';
import type { TransferDiagnostic } from '../../src/transfer-diagnostic';
import type { TransferElement } from '../../src/transfer-element';

interface Root extends TransferElement {
   $type: 'TypeOne';
}

/** An adopter protocol: the framework's, plus methods of its own. */
interface AdopterServer extends DataServerProtocol<Root> {
   getFormDescriptor(args: { id: string }): Promise<{ fields: string[] }>;
}

/** An adopter client: the framework's inbound surface, plus one of its own. */
interface AdopterClient extends DataClientProtocol<Root> {
   onDataModelsChanged(event: { ids: string[] }): void;
}

/** A request/response-only client — the diagnostics shape, which binds nothing. */
type BareClient = Record<string, never>;

async function typeAssertions(
   port: DataPort,
   frameworkClient: DataClientProtocol<Root>,
   adopterClient: AdopterClient,
   bareClient: BareClient
): Promise<void> {
   // Accepted: the default instantiation names one parameter and takes no options.
   new DataConnection<Root>(port, frameworkClient);

   // Accepted: an adopter's own methods survive onto the session's proxy.
   const connection = new DataConnection<Root, AdopterServer, AdopterClient>(port, adopterClient);
   const server = await connection.createSession('adopter').connected();
   await server.getFormDescriptor({ id: 'x' });
   await server.getModelDocument({ uri: 'file:///a.x' });

   // Accepted: a client outside the protocol, declaring its (empty) method list.
   new DataConnection<Root, DataServerProtocol<Root>, BareClient>(port, bareClient, { clientMethods: [] });

   // @ts-expect-error a client outside DataClientProtocol must declare its methods
   new DataConnection<Root, DataServerProtocol<Root>, BareClient>(port, bareClient);

   // @ts-expect-error 'nope' is not a key of AdopterClient
   new DataConnection<Root, AdopterServer, AdopterClient>(port, adopterClient, { clientMethods: ['nope'] });
}

/** An adopter's diagnostic and project, to pin that the fan-out takes both from the server. */
interface RichDiagnostic extends TransferDiagnostic {
   ruleId: string;
}
interface RichProject extends Project {
   vendor: string;
}
type RichServer = DataServerProtocol<Root, RichDiagnostic, RichProject>;

function eventTypeAssertions(port: DataPort): void {
   // Accepted: naming the SERVER is enough — the fan-out reads both shapes off
   // it, so there is no parameter to omit and narrow by.
   const connection = new DataConnectionWithEvents<Root, RichServer>(port);
   connection.events.onDidUpdateDocument(event => {
      const ruleId: string | undefined = event.document.diagnostics[0]?.ruleId;
      void ruleId;
   });
   connection.events.onDidChangeProjects(event => {
      const vendor: string = event.project.vendor;
      void vendor;
   });

   const framework = new DataConnectionWithEvents<Root>(port);
   framework.events.onDidUpdateDocument(event => {
      // @ts-expect-error the default instantiation answers the framework diagnostic
      const absent: string | undefined = event.document.diagnostics[0]?.ruleId;
      void absent;
   });
}

interface UnrelatedServer {
   waitForReady(): Promise<void>;
}
// @ts-expect-error an unrelated shape does not satisfy the server bound
export type RejectedInstantiation = DataConnection<Root, UnrelatedServer, DataClientProtocol<Root>>;

describe('DataConnection type parameters', () => {
   it('compiles, which is the assertion', () => {
      expect(typeAssertions).toBeTypeOf('function');
      expect(eventTypeAssertions).toBeTypeOf('function');
   });
});
