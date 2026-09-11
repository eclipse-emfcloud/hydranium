/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The discrimination self-test for the `/data` battery: proof that each check
 * FAILS when the property it names is broken.
 *
 * The sibling `data-checks.test.ts` covers the planning side (how many checks
 * are built, which are skipped, with what reason) and never invokes a body;
 * the adopter dogfoods run the bodies against a real server and cover only the
 * green direction. Between them, a check that had stopped asserting anything
 * was invisible — which for a kit whose entire product is a verdict is the
 * worst available failure, because the adopter reads it as coverage.
 */

import { describe, expect, it } from 'vitest';
import type { TransferDiagnostic } from '@hydranium/protocol';
import { buildDataChecks, type DataConformanceDriver } from '../src/data/index.js';
import type { ConformanceCheck } from '../src/conformance-suite.js';
import { CANARY_FIXTURE, type CanaryDefects, CanaryDataServer, type CanaryRoot } from './data-canary.js';

/** Every check title fragment the battery plans, in plan order. */
const PROJECT_SHAPE = 'getProjects answers an array of well-formed projects';
const PROJECT_NON_EMPTY = 'getProjects answers at least one project';
const READY = 'waitForReady resolves';
const VALID_ENVELOPE = 'getModelDocument(valid) returns a coherent envelope';
const INVALID_DIAGNOSTICS = 'getModelDocument(invalid) reports at least one diagnostic';
const DIAGNOSTIC_PARAMS = 'a diagnostic carrying a framework message code also carries its params';
const EDIT_REFLECTED = 'updateModelDocument applies an edit';
const SUBSCRIPTION = 'subscribe + update delivers an onDocumentUpdated event';
const FOLDER_CANDIDATES = 'findReferenceCandidates answers for a synthetic source at a folder URI';
const CASCADE = 'editing a document reports its unwatched dependent as built';

/**
 * Build the battery over a canary server. One server instance per battery
 * rather than per check: the kit calls `connect` per check and disposes after,
 * and a fresh instance per call would discard the stored documents the edit
 * and subscription checks depend on — the real driver's `connect` re-boots a
 * server over persistent storage, which a Map does not have.
 */
function batteryOver(defects: CanaryDefects = {}): ConformanceCheck[] {
   const server = new CanaryDataServer(defects);
   const connect = (): DataConformanceDriver<CanaryRoot, TransferDiagnostic> => server;
   return buildDataChecks<CanaryRoot, TransferDiagnostic>({
      connect,
      languages: [CANARY_FIXTURE],
      expectsProjects: true
   });
}

/**
 * Run every planned check and report which ones threw, by title fragment.
 *
 * Sequential rather than `Promise.all`: the checks share one server, and the
 * subscription check asserts what the event log does NOT contain, which a
 * concurrent edit check would populate.
 */
async function failingChecks(defects: CanaryDefects): Promise<string[]> {
   const failures: string[] = [];
   for (const check of batteryOver(defects)) {
      if (!check.body) {
         continue;
      }
      try {
         await check.body();
      } catch {
         failures.push(check.title);
      }
   }
   return failures;
}

/** Titles matching any of the given fragments, so a rename of a title is not a silent miss. */
function matching(titles: readonly string[], fragments: readonly string[]): string[] {
   return titles.filter(title => fragments.some(fragment => title.includes(fragment)));
}

describe('the /data battery discriminates', () => {
   // The PASSING canary, and it is not a formality: a check that had degenerated
   // into rejecting everything satisfies every must-fail case below on its own,
   // and would then redden every adopter rather than reporting a kit whose
   // verdict has stopped meaning anything.
   it('passes every check against a conforming server', async () => {
      expect(await failingChecks({})).toEqual([]);
   });

   it('plans exactly the ten checks the must-fail cases below name', () => {
      // Guards the table against the battery growing: a new check with no canary
      // is the state this whole file exists to prevent, so it fails here rather
      // than going unnoticed.
      const titles = batteryOver().map(check => check.title);
      expect(titles).toHaveLength(10);
      const covered = [
         PROJECT_SHAPE,
         PROJECT_NON_EMPTY,
         READY,
         VALID_ENVELOPE,
         INVALID_DIAGNOSTICS,
         DIAGNOSTIC_PARAMS,
         EDIT_REFLECTED,
         SUBSCRIPTION,
         CASCADE,
         FOLDER_CANDIDATES
      ];
      expect(matching(titles, covered)).toHaveLength(10);
   });

   // Each case breaks exactly ONE property and declares the complete set of
   // checks that must fail — so an over-reaching defect (one that reddens
   // everything) fails this table just as loudly as an under-reaching check.
   const canaries: ReadonlyArray<{ label: string; defects: CanaryDefects; expected: readonly string[] }> = [
      { label: 'a project with an empty id', defects: { emptyProjectId: true }, expected: [PROJECT_SHAPE] },
      { label: 'two projects sharing one id', defects: { duplicateProjectIds: true }, expected: [PROJECT_SHAPE] },
      { label: 'no projects at all, with projects expected', defects: { noProjects: true }, expected: [PROJECT_NON_EMPTY] },
      { label: 'a readiness call that rejects', defects: { readyRejects: true }, expected: [READY] },
      { label: 'a transfer root with a blank $type', defects: { blankRootType: true }, expected: [VALID_ENVELOPE] },
      { label: 'a non-integer envelope version', defects: { fractionalVersion: true }, expected: [VALID_ENVELOPE] },
      { label: 'a diagnostic on a valid model', defects: { diagnosticsOnValid: true }, expected: [VALID_ENVELOPE] },
      { label: 'an invalid model reported clean', defects: { cleanInvalid: true }, expected: [INVALID_DIAGNOSTICS] },
      {
         label: 'a diagnostic keeping its code but dropping its params',
         defects: { diagnosticParamsDropped: true },
         expected: [DIAGNOSTIC_PARAMS]
      },
      { label: 'an edit acknowledged but not stored', defects: { ignoreEdits: true }, expected: [EDIT_REFLECTED] },
      { label: 'a subscription that registers nothing', defects: { silentSubscriptions: true }, expected: [SUBSCRIPTION] },
      { label: 'updates fanned out before any subscription', defects: { notifiesBeforeSubscribe: true }, expected: [SUBSCRIPTION] },
      { label: 'a cascade rebuild reported to nobody', defects: { silentCascade: true }, expected: [CASCADE] },
      { label: 'a cascade report naming the watched document too', defects: { cascadeNamesWatched: true }, expected: [CASCADE] },
      {
         label: 'a picker answering nothing for a source whose URI names no file',
         defects: { noCandidatesAtFolder: true },
         expected: [FOLDER_CANDIDATES]
      }
   ];

   for (const canary of canaries) {
      it(`fails ${canary.expected.length === 1 ? 'exactly one check' : 'exactly its checks'} on ${canary.label}`, async () => {
         const failures = await failingChecks(canary.defects);
         expect(matching(failures, canary.expected)).toHaveLength(canary.expected.length);
         // The complete set, not just the expected members: a defect that
         // reddens an unrelated check has not isolated the assertion it names.
         expect(failures).toHaveLength(canary.expected.length);
      });
   }
});
