/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The wire half of the `/data` discrimination self-test: the three shape
 * guards on `getProjects` that a TYPED fake cannot reach.
 *
 * `data-canary.ts` implements the protocol as TypeScript, so it can only
 * produce values the interface admits — `id: ''` is expressible, `id: 42` is
 * not, and neither is a response that is not an array at all. Those are
 * exactly what the guards defend against, because JSON arrives from a real
 * head with no type to hold it to. Reaching them needs the response to cross
 * a wire, which is what this file does: `makeDuplexConnectionPair` for the
 * transport, `createRpcProxy` for the client, and a hand-registered request
 * handler answering the malformed payload. Nothing here is cast.
 *
 * **Only the `getProjects` shape check runs here**, because it is the only
 * check these guards live in. Driving the whole battery over the wire would
 * also need server→client notification capture for the subscription check,
 * which buys serialization coverage rather than discrimination — a separate
 * piece of value, and not this file's job.
 */

import { describe, expect, it } from 'vitest';
import { bindRpcMethods, createRpcProxy, type TransferDiagnostic } from '@hydranium/protocol';
import { DATA_SERVER_PROTOCOL_METHODS, DATA_SERVER_WIRE_PREFIX, type DataServerProtocol } from '@hydranium/protocol/data';
import { makeDuplexConnectionPair } from '@hydranium/protocol/testing/node';
import { buildDataChecks, type DataConformanceDriver } from '../src/data/index.js';
import { CANARY_FIXTURE, CanaryDataServer, type CanaryRoot } from './data-canary.js';

/** The one check whose assertions this file exists to exercise. */
const PROJECT_SHAPE = 'getProjects answers an array of well-formed projects';

/**
 * Run the `getProjects` shape check against a head that answers that one
 * method with `payload`, verbatim, over a real JSON-RPC round trip. Every
 * other method is bound to the conforming typed fake, so the check under test
 * is the only thing the payload can break.
 *
 * Returns the assertion failure, or `undefined` when the check passed.
 */
async function shapeCheckAgainst(payload: unknown): Promise<Error | undefined> {
   const pair = makeDuplexConnectionPair();
   const server = new CanaryDataServer();
   // Everything but `getProjects` delegates to the conforming fake; the
   // malformed answer is registered directly, because a typed target cannot
   // hold a value its own signature rejects.
   const bound = DATA_SERVER_PROTOCOL_METHODS.filter(name => name !== 'getProjects');
   bindRpcMethods(pair.right, server, bound, { methodNamespace: DATA_SERVER_WIRE_PREFIX });
   pair.right.onRequest(`${DATA_SERVER_WIRE_PREFIX}getProjects`, () => payload);

   const proxy = createRpcProxy<DataServerProtocol<CanaryRoot, TransferDiagnostic>>(pair.left, {
      methodNamespace: DATA_SERVER_WIRE_PREFIX
   });
   const driver: DataConformanceDriver<CanaryRoot, TransferDiagnostic> = { proxy, events: [], dispose: () => undefined };

   const checks = buildDataChecks<CanaryRoot, TransferDiagnostic>({ connect: () => driver, languages: [CANARY_FIXTURE] });
   const matched = checks.filter(check => check.title.includes(PROJECT_SHAPE));
   // Exactly one, so a retitled or split check fails here rather than
   // silently leaving this file exercising nothing.
   expect(matched).toHaveLength(1);

   try {
      await matched[0].body?.();
      return undefined;
   } catch (error: unknown) {
      return error instanceof Error ? error : new Error(String(error));
   } finally {
      pair.dispose();
   }
}

describe('the /data shape guards discriminate over a real wire', () => {
   // The passing subject: a well-formed payload must still pass once it has
   // been through JSON. Without it, a guard that had started rejecting
   // everything would satisfy every case below.
   it('passes on a well-formed projects array', async () => {
      expect(await shapeCheckAgainst([{ id: 'project-one', referenceName: 'one' }])).toBeUndefined();
   });

   // Each payload is malformed in exactly ONE way, and the assertion is on the
   // guard's own message — not merely that something threw. A wire test can
   // fail for transport reasons (a dead connection, a timeout), which would
   // otherwise read as the guard firing.
   const canaries: ReadonlyArray<{ label: string; payload: unknown; message: string }> = [
      { label: 'a response that is not an array', payload: { nope: true }, message: 'did not return an array' },
      { label: 'a project that is not an object', payload: [42], message: 'returned a project with no id' },
      { label: 'a non-string project id', payload: [{ id: 7, referenceName: 'one' }], message: 'returned a project with no id' },
      {
         label: 'a non-string referenceName',
         payload: [{ id: 'project-one', referenceName: 7 }],
         message: 'has no referenceName'
      }
   ];

   for (const canary of canaries) {
      it(`fails on ${canary.label}`, async () => {
         const failure = await shapeCheckAgainst(canary.payload);
         // Defined first, and separately: when the guard stops discriminating
         // the check simply passes, and going straight to the message asserts
         // `undefined` against a string — which reports as an invalid-argument
         // error rather than as "the guard no longer fires", and reads as a
         // broken control instead of a found defect.
         expect(failure, 'the shape check accepted a malformed payload').toBeDefined();
         expect(failure?.message).toContain(canary.message);
      });
   }
});
