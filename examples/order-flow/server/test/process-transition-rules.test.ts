/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The two transition rules, asserted on the TEXT side.
 *
 * They are enforced in three places — the diagram's `EdgeCreationChecker`, the
 * create-transition operation handler, and the `.process` validator — over one
 * shared predicate in `process-transition-rules.ts`. This suite covers the
 * validator half plus the predicate itself.
 *
 * Driven through a real build with validation rather than by calling the
 * contribution: the framework collects `validation.checks` contributions and
 * forwards them to Langium's `ValidationRegistry`, so invoking the class by hand
 * would test the method and not the registration — which is the half that can
 * silently be missing.
 *
 * **Ranges are compared against the offending node's own CST**, never against a
 * literal line number. The fixture carries an explanatory header, so a hardcoded
 * line is a test that breaks when someone edits a comment — and gives a failure
 * that says nothing about the rule.
 */

import { describe, expect, it } from 'vitest';
import type { Diagnostic } from 'vscode-languageserver';
import type { ProcessModel } from '../src/language-server/ast.js';
import { canAddTransition, findTransition, isSelfTransition } from '../src/language-server/process-transition-rules.js';
import { loadFixture, makeWorkspaceHarness, type OrderFlowHarness } from './order-flow-harness.js';

const FIXTURE = 'malformed-transitions.process';

/** `Diagnostic.message` is a plain string here, but the type admits markup. */
function messageOf(diagnostic: Diagnostic): string {
   return typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value;
}

/** Build the fixture and return its root plus the transition-rule diagnostics. */
async function loadMalformed(harness: OrderFlowHarness): Promise<{ root: ProcessModel; reported: Diagnostic[] }> {
   const document = await loadFixture<ProcessModel>(harness, FIXTURE);
   const reported = (document.diagnostics ?? []).filter(diagnostic =>
      /cannot transition to itself|already declared/.test(messageOf(diagnostic))
   );
   return { root: document.parseResult.value, reported };
}

describe('order-flow .process transition rules', () => {
   it('reports exactly the two malformed transitions, and nothing else', async () => {
      const harness = await makeWorkspaceHarness();
      const { root, reported } = await loadMalformed(harness);

      // The fixture declares four transitions, two of them malformed. Asserting
      // the COUNT is what stops a check that flags every transition from
      // passing the two positive cases below.
      expect(root.transitions).toHaveLength(4);
      expect(reported.map(messageOf)).toEqual([
         "'Pay' cannot transition to itself.",
         "A transition from 'Pay' to 'Pick' is already declared."
      ]);
   });

   it('blames the self-transition itself', async () => {
      const harness = await makeWorkspaceHarness();
      const { root, reported } = await loadMalformed(harness);

      const selfTransition = root.transitions.find(transition => transition.source?.ref === transition.target?.ref)!;
      const diagnostic = reported.find(candidate => /itself/.test(messageOf(candidate)))!;
      expect(diagnostic.range.start.line).toBe(selfTransition.$cstNode?.range.start.line);
   });

   it('blames the LATER of a repeated pair, not the original', async () => {
      const harness = await makeWorkspaceHarness();
      const { root, reported } = await loadMalformed(harness);

      // The fixture declares `Pay -> Pick` twice. Reporting both would make
      // every duplicate report twice and leave the author no way to tell which
      // line to delete, so the range has to be the second one's.
      const repeated = root.transitions.filter(
         transition => transition.source?.$refText === 'Pay' && transition.target?.$refText === 'Pick'
      );
      expect(repeated).toHaveLength(2);

      const duplicates = reported.filter(candidate => /already declared/.test(messageOf(candidate)));
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].range.start.line).toBe(repeated[1].$cstNode?.range.start.line);
      expect(duplicates[0].range.start.line).not.toBe(repeated[0].$cstNode?.range.start.line);
   });

   it('leaves the well-formed transition unreported', async () => {
      const harness = await makeWorkspaceHarness();
      const { root, reported } = await loadMalformed(harness);

      // `Pick -> Ship` is fine. Asserted by RANGE rather than by searching the
      // messages for 'Ship': the duplicate's message names `Pick` legitimately,
      // so a message search cannot tell "this transition was blamed" from "this
      // node was mentioned".
      const wellFormed = root.transitions.find(
         transition => transition.source?.$refText === 'Pick' && transition.target?.$refText === 'Ship'
      )!;
      const blamedLines = reported.map(diagnostic => diagnostic.range.start.line);
      expect(blamedLines).not.toContain(wellFormed.$cstNode?.range.start.line);
   });

   it('reports nothing on the sample workspace', async () => {
      // The committed workspace must stay clean, or every other suite that reads
      // its diagnostics inherits noise from this one.
      const harness = await makeWorkspaceHarness();
      const document = harness.shared.workspace.LangiumDocuments.all.find(candidate =>
         candidate.uri.path.endsWith('orders/fulfillment.process')
      );

      const messages = (document?.diagnostics ?? []).map(messageOf);
      expect(messages.filter(message => /cannot transition to itself|already declared/.test(message))).toEqual([]);
   });
});

describe('the shared predicate the diagram and the validator both ask', () => {
   it('answers the same fixture the same way the diagnostics do', async () => {
      // The point of the shared module is that one answer drives all three
      // enforcement points. Asking the predicate directly is what pins them
      // together — a validator that grew its own inline rule would still pass
      // every test above.
      const harness = await makeWorkspaceHarness();
      const { root } = await loadMalformed(harness);
      const node = (name: string) => root.nodes.find(candidate => candidate.name === name)!;
      const [pay, pick, ship] = [node('Pay'), node('Pick'), node('Ship')];

      expect(isSelfTransition(pay, pay)).toBe(true);
      expect(isSelfTransition(pay, pick)).toBe(false);
      expect(findTransition(root, pay, pick)).toBeDefined();
      expect(findTransition(root, ship, pay)).toBeUndefined();
      expect(canAddTransition(root, pay, pay)).toBe(false);
      expect(canAddTransition(root, pay, pick)).toBe(false);
      // The one pair the fixture leaves free, so the predicate is not simply
      // answering false for everything.
      expect(canAddTransition(root, ship, pay)).toBe(true);
   });
});
