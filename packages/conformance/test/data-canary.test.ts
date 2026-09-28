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
const DEPENDENT_CREDIT = "an edit that changes a watched dependent credits the dependent's event to no client";
const CONFLICT_GATE = 'updateModelDocument arms the conflict gate on a based-on snapshot version';
const SESSION_IDS = 'createSession refuses an id already live, and frees it once the session ends';
const RESERVED_IDS = 'createSession refuses every id the framework reserves';
const SESSION_WRITE = 'a session writes only a document it has open';
const CLOSE_SESSION = 'closeSession closes every document the session had open';
const CREATE = 'createModelDocument creates a document open for the session';
const SET = 'updateModelDocuments writes a set all or none';
const SESSION_SAVE = 'a session saves only a document it has open';
const CONNECTION_END = 'ending a connection ends its sessions';
const UNREGISTERED = 'a document request under an id no session was registered for fails';
const WRITE_ANSWER = 'a write of the invalid model answers with its diagnostics';
const DIRTY = 'a document is dirty while its text differs from its file, and clean once saved';
const TEXT_HASH = "a document's text hash is equal for equal text and differs for different text";
const LAST_CLOSE = "the last close drops a document's unsaved text and keeps what its save wrote";
const UNSAVED_CREATE = 'a created document never saved leaves with its last close';

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
      attach: () => server.attach(),
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

   it('passes every check against a server that ends a closed connection’s sessions a moment late', async () => {
      // A server behind a socket refuses the id until it has read the close,
      // which is not a defect; the connection-end check has to wait it out.
      expect(await failingChecks({ endsSessionsLate: true })).toEqual([]);
   });

   it('plans exactly the twenty-six checks the must-fail cases below name', () => {
      // Guards the table against the battery growing: a new check with no canary
      // is the state this whole file exists to prevent, so it fails here rather
      // than going unnoticed.
      const titles = batteryOver().map(check => check.title);
      expect(titles).toHaveLength(26);
      const covered = [
         PROJECT_SHAPE,
         PROJECT_NON_EMPTY,
         READY,
         VALID_ENVELOPE,
         INVALID_DIAGNOSTICS,
         DIAGNOSTIC_PARAMS,
         EDIT_REFLECTED,
         CONFLICT_GATE,
         SUBSCRIPTION,
         CASCADE,
         DEPENDENT_CREDIT,
         FOLDER_CANDIDATES,
         SESSION_IDS,
         RESERVED_IDS,
         SESSION_WRITE,
         CLOSE_SESSION,
         CREATE,
         SET,
         SESSION_SAVE,
         CONNECTION_END,
         UNREGISTERED,
         WRITE_ANSWER,
         DIRTY,
         TEXT_HASH,
         LAST_CLOSE,
         UNSAVED_CREATE
      ];
      expect(matching(titles, covered)).toHaveLength(26);
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
      {
         // Also every check writing on a version the envelope reported, so a
         // head that cannot report a whole one cannot be based on it either.
         label: 'a non-integer envelope version',
         defects: { fractionalVersion: true },
         expected: [VALID_ENVELOPE, CONFLICT_GATE, CREATE, SET]
      },
      { label: 'a diagnostic on a valid model', defects: { diagnosticsOnValid: true }, expected: [VALID_ENVELOPE] },
      {
         // Also the write's answer, which is the same document.
         label: 'an invalid model reported clean',
         defects: { cleanInvalid: true },
         expected: [INVALID_DIAGNOSTICS, WRITE_ANSWER]
      },
      {
         label: 'a diagnostic keeping its code but dropping its params',
         defects: { diagnosticParamsDropped: true },
         expected: [DIAGNOSTIC_PARAMS]
      },
      {
         // Also the gate, and necessarily: a head that stores no edit never
         // advances a version, so nothing a caller holds can go stale. And the
         // set check, whose current set carries an edit, and the dirty,
         // text-hash and last-close checks, whose second text is an edit.
         label: 'an edit acknowledged but not stored',
         defects: { ignoreEdits: true },
         expected: [EDIT_REFLECTED, CONFLICT_GATE, SET, DIRTY, TEXT_HASH, LAST_CLOSE]
      },
      {
         label: 'a write accepted whatever version it claims',
         defects: { ungatedWrites: true },
         expected: [CONFLICT_GATE, SET]
      },
      {
         // Also the dependent's credit, which the check reads off the update
         // channel.
         label: 'a subscription that registers nothing',
         defects: { silentSubscriptions: true },
         expected: [SUBSCRIPTION, DEPENDENT_CREDIT]
      },
      { label: 'updates fanned out before any subscription', defects: { notifiesBeforeSubscribe: true }, expected: [SUBSCRIPTION] },
      {
         // Also the dependent's credit, which holds the writer's own event to
         // the same rule.
         label: 'a write’s own update reported as rebuilt',
         defects: { ownWriteRebuilt: true },
         expected: [SUBSCRIPTION, DEPENDENT_CREDIT]
      },
      { label: 'a cascade rebuild reported to nobody', defects: { silentCascade: true }, expected: [CASCADE] },
      { label: 'a cascade report naming the watched document too', defects: { cascadeNamesWatched: true }, expected: [CASCADE] },
      {
         label: 'a dependent’s update credited to the client that has it open',
         defects: { dependentCreditedToOpener: true },
         expected: [DEPENDENT_CREDIT]
      },
      {
         label: 'a picker answering nothing for a source whose URI names no file',
         defects: { noCandidatesAtFolder: true },
         expected: [FOLDER_CANDIDATES]
      },
      {
         label: 'an id no session was registered for opening and writing documents',
         defects: { plainClientWrites: true },
         expected: [UNREGISTERED]
      },
      { label: 'a live session id accepted a second time', defects: { sessionIdsReused: true }, expected: [SESSION_IDS] },
      { label: 'a reserved id accepted for a session', defects: { reservedIdsAccepted: true }, expected: [RESERVED_IDS] },
      {
         // Also the close check, which observes the end through a new session
         // under the same id.
         label: 'an ended session id never freed',
         defects: { sessionIdsKept: true },
         expected: [SESSION_IDS, CLOSE_SESSION]
      },
      {
         // Also the close check: the new session under the ended one's id then
         // writes by opening implicitly, which is what that check refuses.
         label: 'a session write opening its document implicitly',
         defects: { implicitSessionOpen: true },
         expected: [SESSION_WRITE, CLOSE_SESSION, SESSION_SAVE, CONNECTION_END]
      },
      { label: 'a session close that leaves the document open', defects: { closeKeepsOpen: true }, expected: [SESSION_WRITE] },
      { label: 'opens that outlive their session', defects: { sessionOpensSurviveEnd: true }, expected: [CLOSE_SESSION] },
      { label: 'a create that replaces an existing document', defects: { createOverwrites: true }, expected: [CREATE] },
      {
         // Also every check that goes on to write, save or close what it created.
         label: 'a create that leaves the document closed',
         defects: { createLeavesClosed: true },
         expected: [CREATE, DIRTY, TEXT_HASH, LAST_CLOSE, UNSAVED_CREATE]
      },
      { label: 'a set applied one document at a time', defects: { partialSets: true }, expected: [SET] },
      { label: 'a session save opening its document implicitly', defects: { saveOpensImplicitly: true }, expected: [SESSION_SAVE] },
      { label: 'sessions outliving their connection', defects: { sessionsOutliveConnection: true }, expected: [CONNECTION_END] },
      { label: 'a write answered before its document is validated', defects: { writeAnswersUnvalidated: true }, expected: [WRITE_ANSWER] },
      { label: 'every document reported clean', defects: { neverDirty: true }, expected: [DIRTY] },
      { label: 'a text hash that follows the version', defects: { textHashByVersion: true }, expected: [TEXT_HASH] },
      { label: 'a last close keeping a saved document’s unsaved text', defects: { releaseKeepsText: true }, expected: [LAST_CLOSE] },
      { label: 'a last close keeping a document with no file', defects: { releaseKeepsUnsaved: true }, expected: [UNSAVED_CREATE] },
      {
         // Also the text-hash check, which reads a URI with no document for
         // the envelope that carries no hash.
         label: 'a read of a URI with no document that is refused',
         defects: { refusesUnknownRead: true },
         expected: [TEXT_HASH, UNSAVED_CREATE]
      },
      {
         label: 'a close reverting while another session has the document open',
         defects: { releaseOnAnyClose: true },
         expected: [LAST_CLOSE]
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
