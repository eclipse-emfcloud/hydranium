/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { makeAstSnapshot } from '@hydranium/core/testing';
import { makeGoldenCorpus } from '@hydranium/core/testing/node';
import { type AstNode, URI } from '@hydranium/langium';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createOrderFlowServices } from '../src/language-server/order-flow-module.js';

/**
 * Serializer golden corpus for order-flow — three grammars, ONE corpus.
 *
 * The serializer's *output format* is the thing under test, so the corpus is
 * committed golden files (the framework's `makeGoldenCorpus` walks them) rather
 * than runner snapshots: an accidental formatting change — an indent-unit flip
 * is the cautionary tale — then surfaces as a readable diff against a committed
 * file in review, and updating a golden is a deliberate edit (no `-u`
 * rubber-stamp).
 *
 * The corpus is read with NO extension filter and every fixture is routed to a
 * serializer by its own URI, so dropping a `.domain`, `.process` or `.layout`
 * file into `fixtures/serializer/` extends the corpus with no code change — and
 * each case doubles as coverage of per-URI serializer resolution over three
 * grammars, which a single-grammar corpus cannot express.
 *
 * **The goldens are standalone.** Nothing here builds, links or validates, and
 * no fixture needs a counterpart file even though a `.process` names an entity
 * and a `.layout` names a process: all three serializers read a
 * cross-reference's *text* rather than its resolved target
 * (`AbstractSerializer.serializeReferenceText`), and `makeAstSnapshot` reduces a
 * `Reference` to its `$refText`. An unresolvable reference round-trips as the
 * text the author typed, which is the behaviour the corpus pins.
 *
 * Two properties:
 *
 * 1. **Byte-stability** — `serialize(parse(golden)) === golden` per fixture. The
 *    golden is canonical serializer output; re-serializing its parse must
 *    reproduce it byte-for-byte.
 * 2. **Round-trip safety** — `makeAstSnapshot(parse(serialize(parse(x))))`
 *    deep-equals `makeAstSnapshot(parse(x))` for messy inputs `x`, proving
 *    serialization preserves the semantic model independent of whitespace,
 *    inline-versus-indented effects, the interleaving of flow nodes with
 *    transitions, and dropped comments.
 *
 * The two are not the same assertion, and the corpus is arranged to keep that
 * visible: an inline `reads` effect appears only among the messy inputs, so an
 * emitter that dropped reads would fail (2) while every golden still reproduced
 * byte-for-byte. The `reads` output format itself is pinned against the sample
 * workspace in `serializer.test.ts`.
 *
 * One deliberate non-property: `LayoutSerializer` rounds coordinates to two
 * decimals (see its `emitNumber` doc for why), so a sub-pixel input such as
 * `10.005` is lossy by design and stays out of the messy set.
 */

const { shared } = createOrderFlowServices();
const documentFactory = shared.workspace.LangiumDocumentFactory;

let counter = 0;

/** Parse fixture text under `uri` — which is also what routes it to a grammar. */
function parse(text: string, uri: URI): AstNode {
   const document = documentFactory.fromString(text, uri);
   expect(document.parseResult.lexerErrors, uri.toString()).toHaveLength(0);
   expect(document.parseResult.parserErrors, uri.toString()).toHaveLength(0);
   return document.parseResult.value;
}

/** Serialize through the serializer `uri` routes to, per-URI as the write paths do. */
async function serialize(model: AstNode, uri: URI): Promise<string> {
   return shared.ServiceRegistry.getServices(uri).serializer.Serializer.serializeAst(model);
}

const fixturesDirectory = fileURLToPath(new URL('./fixtures/serializer', import.meta.url));
const corpus = makeGoldenCorpus(fixturesDirectory);

describe('order-flow serializer golden corpus', () => {
   describe.each(corpus)('golden: $name', ({ path, text }) => {
      const uri = URI.file(path);
      // The serializers emit no trailing newline; goldens carry the
      // editorconfig-mandated final newline, so normalise exactly one.
      const golden = text.replace(/\n$/, '');

      it('serialize(parse(golden)) reproduces the golden byte-for-byte', async () => {
         expect(await serialize(parse(golden, uri), uri)).toBe(golden);
      });
   });

   describe('round-trip safety on non-canonical inputs', () => {
      it.each([
         [
            'effects written inline after the task name (canonical puts one per line)',
            '.process',
            `process Inline for Shipment {
                task Pack writes Shipment.status = PACKED reads Shipment.id
                task Ship
                transition Pack -> Ship
             }`
         ],
         [
            'gateway branches inline after the gateway name',
            '.process',
            `process Branching for Shipment { gateway Weighed heavy -> Freight light -> Courier
                task Freight task Courier }`
         ],
         [
            'transitions interleaved with flow nodes (canonical groups nodes first)',
            '.process',
            `process Interleaved for Shipment {
                transition Pack -> Ship
                task Pack
                transition Ship -> Pack
                task Ship
             }`
         ],
         [
            'cramped fields — no spaces around the colon, the brackets or the braces',
            '.domain',
            `entity   Cramped{sku :ID
                tags: Barcode [ ]}


             valuetype Barcode {}`
         ],
         [
            'line and block comments (hidden terminals, dropped on serialize)',
            '.domain',
            `// header comment
             project shipping requires commerce-core , extras
             /* an entity */ entity Shipment { id: ID }
             enum Status { NEW , PACKED }`
         ],
         [
            'layout entries on one line, mixing measured and unmeasured nodes',
            '.layout',
            `layout Cramped for Dispatch{node Pack at 40,40 size 160,60
             node Weighed at 40 , 160}`
         ]
      ])('preserves the semantic model through parse → serialize → parse (%s)', async (_label, extension, source) => {
         const uri = URI.parse(`memory:///round-trip-${counter++}${extension}`);
         const original = parse(source, uri);
         const reparsed = parse(await serialize(original, uri), uri);
         expect(makeAstSnapshot(reparsed)).toEqual(makeAstSnapshot(original));
      });
   });
});
