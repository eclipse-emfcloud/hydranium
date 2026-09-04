/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `runUpdatePipeline` — the driver's two load-bearing properties.
 *
 * The defect it exists to prevent is a hand-copied rewrite chain going stale,
 * so the test that matters is not "it calls the two services": it is that the
 * ORDER comes from the registry at call time, and that the language comes from
 * the URI. A driver satisfying neither would still pass a "returns text" test.
 *
 * Two stub languages rather than one, because a single-language tree cannot
 * tell "resolved per URI" apart from "resolved from the only language there
 * is" — the same reason the framework gates its multi-grammar claims on the
 * three-grammar example.
 */

import { describe, expect, it } from 'vitest';
import type { TransferElement } from '@hydranium/protocol';
import type { AstNode } from '@hydranium/langium';
import { DefaultUpdateRewriteService } from '../../src/langium/update-rewrite/update-rewrite-service.js';
import { makeNoopLanguageServices } from '../../src/testing/make-noop-language-services.js';
import { makeTestServices } from '../../src/testing/make-test-services.js';
import { runUpdatePipeline } from '../../src/testing/run-update-pipeline.js';

/** A transfer shape whose one field records what each rewrite did to it. */
interface TraceElement extends TransferElement {
   $type: 'TypeOne';
   trace: string;
}

/** A serializer that reveals the model's state rather than a concrete syntax. */
function makeTraceSerializer(label: string): { serializeTransfer(root: TraceElement): string } {
   return {
      serializeTransfer: (root: TraceElement) => `${label}:${root.trace}`
   };
}

/**
 * A language whose rewrite chain appends its own marks, registered in an order
 * that DISAGREES with their priorities — so a driver that iterates registration
 * order rather than priority order produces a different string.
 */
function makeTraceLanguage(label: string, marks: readonly { id: string; priority: number; mark: string }[]) {
   const languageServices = makeNoopLanguageServices();
   const rewriteService = new DefaultUpdateRewriteService<TraceElement, AstNode>(languageServices);
   for (const entry of marks) {
      rewriteService.register({
         id: entry.id,
         priority: entry.priority,
         rewrite: (model: TraceElement) => ({ ...model, trace: `${model.trace}${entry.mark}` })
      });
   }
   return {
      rewriteService,
      services: {
         updateRewrite: { UpdateRewriteService: rewriteService, rewrites: {} },
         serializer: { Serializer: makeTraceSerializer(label) }
      }
   };
}

/**
 * A tree with two languages, each with its own chain and serializer.
 *
 * `.one` registers its rewrites in reverse priority order on purpose: `b` is
 * registered first at priority 10 and `a` second at priority -10, so
 * registration order gives `ba` and priority order gives `ab`.
 */
function makeTwoLanguageTree() {
   const one = makeTraceLanguage('one', [
      { id: 'b', priority: 10, mark: 'b' },
      { id: 'a', priority: -10, mark: 'a' }
   ]);
   const two = makeTraceLanguage('two', [{ id: 'z', priority: 0, mark: 'z' }]);
   const bundle = makeTestServices({
      languages: [
         { languageId: 'one', fileExtensions: ['.one'], services: one.services },
         { languageId: 'two', fileExtensions: ['.two'], services: two.services }
      ]
   });
   return { bundle, one, two };
}

const MODEL: TraceElement = { $type: 'TypeOne', trace: '' };

describe('runUpdatePipeline', () => {
   it('runs the chain in priority order, not registration order', async () => {
      const { bundle } = makeTwoLanguageTree();

      const result = await runUpdatePipeline<TraceElement>(bundle.services, { uri: 'file:///a.one', model: MODEL });

      // 'ab' is priority order; 'ba' is the order a hand-copied chain written
      // from the registration site would have produced.
      expect(result.rewritten.trace).toBe('ab');
      expect(result.text).toBe('one:ab');
   });

   it('resolves the chain and the serializer from the URI, not from a fixed language', async () => {
      const { bundle } = makeTwoLanguageTree();

      const first = await runUpdatePipeline<TraceElement>(bundle.services, { uri: 'file:///a.one', model: MODEL });
      const second = await runUpdatePipeline<TraceElement>(bundle.services, { uri: 'file:///a.two', model: MODEL });

      // Both halves must move together: a driver that routed the rewrite by URI
      // but the serializer by a captured handle would produce 'one:z'.
      expect(first.text).toBe('one:ab');
      expect(second.text).toBe('two:z');
   });

   it('picks up a rewrite registered after the driver was first used', async () => {
      const { bundle, one } = makeTwoLanguageTree();
      await runUpdatePipeline<TraceElement>(bundle.services, { uri: 'file:///a.one', model: MODEL });

      // The drift the driver exists to prevent, in its smallest form: a rewrite
      // added later has to run, and at its own priority rather than last.
      one.rewriteService.register({
         id: 'middle',
         priority: 0,
         rewrite: (model: TraceElement) => ({ ...model, trace: `${model.trace}m` })
      });

      const result = await runUpdatePipeline<TraceElement>(bundle.services, { uri: 'file:///a.one', model: MODEL });

      expect(result.rewritten.trace).toBe('amb');
   });

   it('threads an explicit previous root into every rewrite', async () => {
      const seen: (AstNode | undefined)[] = [];
      const previous = { $type: 'TypeOne' } as AstNode;
      const languageServices = makeNoopLanguageServices();
      const rewriteService = new DefaultUpdateRewriteService<TraceElement, AstNode>(languageServices);
      rewriteService.register({
         id: 'record-previous',
         priority: 0,
         rewrite: (model: TraceElement, prior) => {
            seen.push(prior);
            return model;
         }
      });
      const tree = makeTestServices({
         languages: [
            {
               languageId: 'three',
               fileExtensions: ['.three'],
               services: {
                  updateRewrite: { UpdateRewriteService: rewriteService, rewrites: {} },
                  serializer: { Serializer: makeTraceSerializer('three') }
               }
            }
         ]
      });

      await runUpdatePipeline<TraceElement, AstNode>(tree.services, { uri: 'file:///a.three', model: MODEL, previous });

      // A diff-based rewrite is the whole reason `previous` exists, so a driver
      // that dropped it would silently turn every such rewrite into a unary one.
      expect(seen).toEqual([previous]);
   });
});
