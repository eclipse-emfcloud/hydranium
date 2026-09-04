/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type {
   FindNextNameArgs,
   ReferenceCandidate,
   ReferenceContext,
   ReferenceRequest,
   ReferenceServerProtocol,
   ReferenceTarget,
   TransferElement
} from '@hydranium/protocol';
import { AbstractDataServiceFrontend } from './data-service-frontend';

/**
 * {@link AbstractDataServiceFrontend} specialised for a server that also
 * composes the framework {@link ReferenceServerProtocol} fragment. It
 * implements each reference method as a readiness-gated pass-through —
 * `await this.ensureConnected()`, then delegate to `this.server` — so an
 * adopter frontend gets the candidate / resolve / next-name surface without
 * hand-writing identical one-liner bodies.
 *
 * The sibling of `AbstractDiagnosticsDataServiceFrontend`, and the same
 * shape for the same reason: `this.server` is already a forwarding proxy, but
 * it queues only on the channel being live, not on the server's `waitForReady`
 * gate — so the gate has to be interposed per method.
 *
 * Extend this instead of {@link AbstractDataServiceFrontend} whenever the
 * head's `DataServer` registers the reference fragment (typically via a
 * subclass's `additionalMethods`, since
 * `REFERENCE_SERVER_PROTOCOL_METHODS` is deliberately NOT part of
 * `DATA_SERVER_PROTOCOL_METHODS`). The `TServer` bound carries
 * `ReferenceServerProtocol`, so the delegates are type-checked without casts.
 *
 * A frontend needing both fragments extends the diagnostics base and mixes
 * these three in, or vice versa — TypeScript allows only one base class, so
 * the two bases are deliberately independent rather than chained. Chaining
 * them would force every reference-fragment adopter to also carry the
 * diagnostics surface, which a head that dropped those methods via
 * `DataServerOptions.excludedMethods` cannot satisfy.
 */
export abstract class AbstractReferencesDataServiceFrontend<
   TTransfer extends TransferElement,
   TServer extends { waitForReady(): Promise<void> } & ReferenceServerProtocol<TTransfer>,
   TClient extends object
>
   extends AbstractDataServiceFrontend<TServer, TClient>
   implements ReferenceServerProtocol<TTransfer>
{
   async findReferenceCandidates(ctx: ReferenceContext): Promise<ReferenceCandidate[]> {
      await this.ensureConnected();
      return this.server.findReferenceCandidates(ctx);
   }

   async resolveReference(ref: ReferenceRequest): Promise<ReferenceTarget<TTransfer> | undefined> {
      await this.ensureConnected();
      return this.server.resolveReference(ref);
   }

   async findNextName(args: FindNextNameArgs): Promise<string> {
      await this.ensureConnected();
      return this.server.findNextName(args);
   }
}
