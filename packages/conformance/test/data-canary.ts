/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A conforming in-memory data-server, plus the single-property defects that
 * make one named check fail.
 *
 * This exists because a conformance check is only worth running if it can
 * FAIL, and nothing else in this repository can tell the difference between
 * "the adopter's server is correct" and "the check stopped discriminating".
 * The adopter dogfoods run every check against a real server and prove the
 * green direction; a check that had degenerated into an unconditional pass is
 * green there too, and reads as coverage.
 *
 * Shaped after `scripts/check-package-readmes.mjs`: one well-formed subject
 * that must PASS, and every must-fail canary derived from it by breaking
 * exactly ONE property. A canary that reddens has therefore isolated the
 * assertion it names rather than tripping over an unrelated gap, and the
 * passing canary catches the opposite degeneration — a check that has started
 * rejecting everything satisfies every must-fail canary on its own.
 *
 * **The `getProjects` shape guards are canaried NEXT DOOR, not here.**
 * `Array.isArray(projects)` and the `typeof project.id` / `referenceName`
 * guards defend against a wrong JSON shape, which a typed fake cannot produce
 * without the cast this repository forbids — so `data-wire-canary.test.ts`
 * drives that one check over a real JSON-RPC round trip instead. Both files
 * are needed: a wire driver reaches shapes the type system rejects, and this
 * one reaches behaviours (subscription tables, edit persistence) that would
 * cost a full server implementation to reproduce over a wire.
 */

import {
   asSnapshotVersion,
   ConflictError,
   DocumentNotOpenError,
   DuplicateClientIdError,
   FRAMEWORK_CLIENT_IDS,
   isDocumentSource,
   isSnapshotVersion,
   isSyntheticSource,
   ReservedClientIdError,
   SessionClosedError,
   TransferDocument,
   UNKNOWN_CLIENT_ID
} from '@hydranium/protocol';
import type {
   CloseModelArgs,
   OpenModelArgs,
   Project,
   ReferenceCandidate,
   ReferenceContext,
   TransferDiagnostic,
   TransferElement
} from '@hydranium/protocol';
import type {
   CloseSessionArgs,
   CreateModelDocumentArgs,
   CreateSessionArgs,
   GetModelDocumentArgs,
   GetProjectForUriArgs,
   TransferDocumentsBuiltEvent,
   TransferDocumentUpdatedEvent,
   TransferSaveDocumentArgs,
   TransferUpdateDocumentArgs,
   TransferUpdateDocumentsArgs,
   WatchModelDocumentArgs
} from '@hydranium/protocol/data';
import type { LanguageFixture } from '../src/model.js';

/**
 * The canary's transfer root. `text` carries the model text back to the
 * fixture's `edit.expect`, which is the only way an in-memory fake can make
 * "the edit was reflected" observable without owning a grammar.
 */
export interface CanaryRoot extends TransferElement {
   readonly $type: string;
   readonly text: string;
}

/** Typeguard for the root the canary server produces, so `edit.expect` needs no cast. */
export function isCanaryRoot(value: unknown): value is CanaryRoot {
   return typeof value === 'object' && value !== null && 'text' in value && typeof (value as { text: unknown }).text === 'string';
}

export const VALID_TEXT = 'element One';
export const INVALID_TEXT = 'element';
export const EDITED_TEXT = 'element Two';
/** The fixture's `breakingEdit`, the one text of `valid` the canary lets change its dependent. */
export const BREAKING_TEXT = 'element Renamed';

/**
 * The canary's whole "grammar": a model is invalid when it is exactly
 * {@link INVALID_TEXT}. Deliberately identity on a literal rather than a
 * parser — the kit's checks need only that valid and invalid differ
 * OBSERVABLY, and a real parser here would be a second implementation to keep
 * correct for no added discrimination.
 */
function diagnosticsFor(text: string, defects: CanaryDefects = {}): TransferDiagnostic[] {
   return text === INVALID_TEXT ? [canaryDiagnostic('the canary grammar wants a name', defects)] : [];
}

/**
 * Carries a framework message identity, because the half-identity check has
 * nothing to discriminate against a diagnostic that has none — it passes
 * vacuously on an empty `code`, which would read as coverage.
 */
function canaryDiagnostic(message: string, defects: CanaryDefects = {}): TransferDiagnostic {
   return {
      type: 'validation-error',
      element: '',
      message,
      severity: 'error',
      code: 'hydranium/canary/wants-a-name',
      params: defects.diagnosticParamsDropped ? undefined : {}
   };
}

/**
 * One deliberately-broken behaviour. Every field defaults to conforming, so a
 * canary sets exactly one and the rest of the server stays correct — which is
 * what makes the resulting failure attributable.
 */
export interface CanaryDefects {
   /** `getProjects` answers a project whose `id` is the empty string. */
   readonly emptyProjectId?: boolean;
   /** `getProjects` answers two projects sharing one `id`. */
   readonly duplicateProjectIds?: boolean;
   /** `getProjects` answers `[]` even though the options claim a project tier. */
   readonly noProjects?: boolean;
   /** `waitForReady` rejects instead of resolving. */
   readonly readyRejects?: boolean;
   /** The transfer root carries an empty `$type`. */
   readonly blankRootType?: boolean;
   /** The envelope's `version` is a non-integer. */
   readonly fractionalVersion?: boolean;
   /** A valid model is reported with a diagnostic anyway. */
   readonly diagnosticsOnValid?: boolean;
   /** An invalid model is reported clean. */
   readonly cleanInvalid?: boolean;
   /**
    * A diagnostic keeps its framework message code but drops the params — the
    * half-carried identity a rebound `toTransferDiagnostic` produces, which
    * renders a translated template with its placeholders left standing.
    */
   readonly diagnosticParamsDropped?: boolean;
   /** `updateModelDocument` acknowledges an edit without storing it. */
   readonly ignoreEdits?: boolean;
   /** `watchModelDocument` registers nothing, so no event is ever delivered. */
   readonly silentSubscriptions?: boolean;
   /** Updates are fanned out regardless of the subscription table. */
   readonly notifiesBeforeSubscribe?: boolean;
   /** A write's own update event is reported as rebuilt rather than changed. */
   readonly ownWriteRebuilt?: boolean;
   /**
    * A document rebuilt as a cascade is never reported, which is the state a
    * head is in when it gates its build notification on the subscription map:
    * the dependent has no watcher, so gating it silences the one channel that
    * could carry it.
    */
   readonly silentCascade?: boolean;
   /** The cascade report names the WATCHED document too, which the update channel already carried. */
   readonly cascadeNamesWatched?: boolean;
   /**
    * A dependent's update event names the client that has it open, which then
    * drops the event as its own echo.
    */
   readonly dependentCreditedToOpener?: boolean;
   /**
    * Every write lands, whatever version it claims to be based on — the head
    * that accepts `basedOn` on the wire and never compares it, so a form editor
    * overwrites a concurrent text edit with nothing logged.
    */
   readonly ungatedWrites?: boolean;
   /**
    * A synthetic source whose URI names no file answers `[]` instead of the
    * project's candidates — the create-dialog defect: a head that routes only
    * by URI extension has nothing to route a folder on, so the picker comes
    * back empty and the dialog never opens.
    */
   readonly noCandidatesAtFolder?: boolean;
   /** `createSession` accepts an id a live session already holds. */
   readonly sessionIdsReused?: boolean;
   /** `createSession` accepts an id the framework reserves. */
   readonly reservedIdsAccepted?: boolean;
   /** `closeSession` leaves the id taken, so it can never identify a session again. */
   readonly sessionIdsKept?: boolean;
   /** An id no session was registered for opens and writes documents. */
   readonly plainClientWrites?: boolean;
   /** A session's write of a document it has not opened opens it. */
   readonly implicitSessionOpen?: boolean;
   /** `closeModelDocument` leaves the session's open in place. */
   readonly closeKeepsOpen?: boolean;
   /** `closeSession` frees the id but keeps its opens, which a new session under it then inherits. */
   readonly sessionOpensSurviveEnd?: boolean;
   /** `createModelDocument` replaces a document that exists instead of refusing it. */
   readonly createOverwrites?: boolean;
   /** `createModelDocument` creates the document without opening it for the session. */
   readonly createLeavesClosed?: boolean;
   /** `updateModelDocuments` checks and applies one document at a time, so a later stale one leaves the earlier applied. */
   readonly partialSets?: boolean;
   /** A session's save of a document it has not opened opens it. */
   readonly saveOpensImplicitly?: boolean;
   /** Closing a connection leaves its sessions live. */
   readonly sessionsOutliveConnection?: boolean;
   /** A write answers with no diagnostics, as a head answering before its document is validated does. */
   readonly writeAnswersUnvalidated?: boolean;
   /** Every document is reported clean, saved or not. */
   readonly neverDirty?: boolean;
   /** The last close keeps a saved document's unsaved text instead of going back to its file. */
   readonly releaseKeepsText?: boolean;
   /** The last close keeps a document that has no file. */
   readonly releaseKeepsUnsaved?: boolean;
   /** A read of a URI the server has no document for is refused, where the protocol answers an envelope with no root. */
   readonly refusesUnknownRead?: boolean;
   /** Any close goes back to the file, even while another session has the document open. */
   readonly releaseOnAnyClose?: boolean;
   /**
    * Not a defect: closing a connection ends its sessions only a moment later,
    * as a server behind a socket does once it has read the close.
    */
   readonly endsSessionsLate?: boolean;
}

interface StoredDocument {
   text: string;
   version: number;
}

/**
 * A data-server that satisfies every check in the `/data` battery, or fails
 * exactly one of them under a {@link CanaryDefects} flag.
 *
 * Implements the full {@link DataServerProtocol} surface because the driver
 * port is the protocol-native proxy; the methods no check calls are present to
 * satisfy the contract and reject if reached, so a check that silently grew a
 * new dependency shows up as a failure here rather than as a passing fake.
 */
export class CanaryDataServer {
   readonly events: TransferDocumentUpdatedEvent<CanaryRoot, TransferDiagnostic>[] = [];
   /** The canary provokes no cascade — it stores documents in a Map with no reference graph. */
   readonly builds: TransferDocumentsBuiltEvent[] = [];

   private readonly documents = new Map<string, StoredDocument>();
   /** What each save wrote, by URI: the file a last close goes back to. */
   private readonly disk = new Map<string, string>();
   private readonly watched = new Set<string>();
   /** Live session ids, and the URIs each has open. */
   private readonly sessions = new Map<string, Set<string>>();
   /** Opens left behind by an ended session, under `sessionOpensSurviveEnd`. */
   private readonly orphanedOpens = new Map<string, Set<string>>();
   /** Ids `closeSession` failed to free, under `sessionIdsKept`. */
   private readonly keptIds = new Set<string>();

   constructor(private readonly defects: CanaryDefects = {}) {}

   get proxy(): this {
      return this;
   }

   /** The opt-in reference surface — the same object, as the real harness does. */
   get references(): this {
      return this;
   }

   /**
    * Answers the one candidate {@link CANARY_FIXTURE} expects, for a source at
    * any URI — including one naming no file, which is the property under test.
    * Under `noCandidatesAtFolder` it answers only for a source whose URI has a
    * file extension, which is exactly how a URI-extension-routed head behaves.
    */
   async findReferenceCandidates(ctx: ReferenceContext): Promise<ReferenceCandidate[]> {
      // Only a document/synthetic source carries a URI; an id-based
      // `ElementSource` has none, and answering it is not what this canary is
      // for, so the empty string routes it down the no-file branch.
      const uri = isDocumentSource(ctx.source) || isSyntheticSource(ctx.source) ? ctx.source.uri : '';
      const namesAFile = /\.[^./]+$/.test(uri);
      if (this.defects.noCandidatesAtFolder && !namesAFile) {
         return [];
      }
      return [{ label: CANARY_CANDIDATE, value: `${CANARY_CANDIDATE}_id`, uri: 'file:///one.x', type: 'CanaryTarget' }];
   }

   /**
    * Present to satisfy `ReferenceServerProtocol`, and rejecting rather than
    * answering: no check calls it, so a check that silently grows a dependency
    * on it surfaces here as a failure instead of passing against a fake.
    */
   async resolveReference(): Promise<never> {
      throw new Error('the canary server does not implement resolveReference');
   }

   /** Same contract as {@link resolveReference}: no check calls it. */
   async findNextName(): Promise<never> {
      throw new Error('the canary server does not implement findNextName');
   }

   /** A second connection to this server: shares its state, and closing it ends nothing. */
   attach(): CanaryDataServer {
      return Object.assign(Object.create(this) as CanaryDataServer, { dispose: () => undefined });
   }

   dispose(): void {
      this.documents.clear();
      this.disk.clear();
      this.watched.clear();
      if (this.defects.endsSessionsLate) {
         const sessions = [...this.sessions.keys()];
         setTimeout(() => sessions.forEach(clientId => this.sessions.delete(clientId)), 50);
      } else if (!this.defects.sessionsOutliveConnection) {
         this.sessions.clear();
      }
      this.orphanedOpens.clear();
      this.keptIds.clear();
   }

   async getProjects(): Promise<readonly Project[]> {
      if (this.defects.noProjects) {
         return [];
      }
      if (this.defects.emptyProjectId) {
         return [{ id: '', referenceName: 'one' }];
      }
      if (this.defects.duplicateProjectIds) {
         return [
            { id: 'project-one', referenceName: 'one' },
            { id: 'project-one', referenceName: 'two' }
         ];
      }
      return [{ id: 'project-one', referenceName: 'one' }];
   }

   async getProjectForUri(_args: GetProjectForUriArgs): Promise<Project | undefined> {
      return { id: 'project-one', referenceName: 'one' };
   }

   async waitForReady(): Promise<void> {
      if (this.defects.readyRejects) {
         throw new Error('the canary server never became ready');
      }
   }

   async getModelDocument(args: GetModelDocumentArgs): Promise<TransferDocument<CanaryRoot, TransferDiagnostic>> {
      if (this.defects.refusesUnknownRead && !this.documents.has(args.uri)) {
         throw new Error(`No document found for URI: ${args.uri}`);
      }
      return this.envelope(args.uri);
   }

   async createSession(args: CreateSessionArgs): Promise<void> {
      if (FRAMEWORK_CLIENT_IDS.includes(args.clientId) && !this.defects.reservedIdsAccepted) {
         throw new ReservedClientIdError(args.clientId);
      }
      if ((this.sessions.has(args.clientId) && !this.defects.sessionIdsReused) || this.keptIds.has(args.clientId)) {
         throw new DuplicateClientIdError(args.clientId);
      }
      const inherited = this.orphanedOpens.get(args.clientId);
      this.orphanedOpens.delete(args.clientId);
      this.sessions.set(args.clientId, inherited ?? new Set<string>());
   }

   async closeSession(args: CloseSessionArgs): Promise<void> {
      const opens = this.sessions.get(args.clientId);
      this.sessions.delete(args.clientId);
      if (opens && this.defects.sessionOpensSurviveEnd) {
         this.orphanedOpens.set(args.clientId, opens);
      }
      if (this.defects.sessionIdsKept) {
         this.keptIds.add(args.clientId);
      }
      opens?.forEach(uri => this.releaseIfClosed(uri));
   }

   /** Once no session has `uri` open, go back to what its last save wrote, or drop it when none did. */
   private releaseIfClosed(uri: string): void {
      if (!this.defects.releaseOnAnyClose && [...this.sessions.values()].some(opens => opens.has(uri))) {
         return;
      }
      const saved = this.disk.get(uri);
      if (saved !== undefined && !this.defects.releaseKeepsText) {
         this.documents.set(uri, { text: saved, version: (this.documents.get(uri)?.version ?? 0) + 1 });
      } else if (saved === undefined && !this.defects.releaseKeepsUnsaved) {
         this.documents.delete(uri);
      }
   }

   async createModelDocument(args: CreateModelDocumentArgs): Promise<TransferDocument<CanaryRoot, TransferDiagnostic>> {
      const opens = this.sessions.get(args.clientId);
      if (!opens) {
         throw new Error(`${args.clientId} is not a session`);
      }
      if (this.documents.has(args.uri) && !this.defects.createOverwrites) {
         throw new Error(`Cannot create ${args.uri}: the file exists`);
      }
      this.documents.set(args.uri, { text: args.text, version: (this.documents.get(args.uri)?.version ?? 0) + 1 });
      if (!this.defects.createLeavesClosed) {
         opens.add(args.uri);
      }
      return this.envelope(args.uri);
   }

   async updateModelDocuments(args: TransferUpdateDocumentsArgs<CanaryRoot>): Promise<TransferDocument<CanaryRoot, TransferDiagnostic>[]> {
      if (!this.defects.partialSets) {
         // Every check before any apply; the per-document write repeats them
         // harmlessly.
         for (const update of args.updates) {
            this.assertSessionMayWrite(args.clientId, update.uri);
            this.assertBasedOn(update.uri, update.basedOn);
         }
      }
      const documents: TransferDocument<CanaryRoot, TransferDiagnostic>[] = [];
      for (const update of args.updates) {
         documents.push(await this.updateModelDocument({ ...update, clientId: args.clientId }));
      }
      return documents;
   }

   /** A live session writes only what it has open; any other id writes nothing. */
   private assertSessionMayWrite(clientId: string, uri: string): void {
      const opens = this.sessions.get(clientId);
      if (!opens) {
         this.assertPlainClientAllowed(clientId);
         return;
      }
      if (opens.has(uri)) {
         return;
      }
      if (this.defects.implicitSessionOpen) {
         opens.add(uri);
         return;
      }
      throw new DocumentNotOpenError(uri, clientId);
   }

   private assertPlainClientAllowed(clientId: string): void {
      if (!this.defects.plainClientWrites) {
         throw new SessionClosedError(clientId);
      }
   }

   private assertBasedOn(uri: string, basedOn: TransferUpdateDocumentArgs<CanaryRoot>['basedOn']): void {
      // An unknown URI answers v0, so a write claiming a version against a
      // document that does not exist is stale rather than unchecked.
      if (!this.defects.ungatedWrites && isSnapshotVersion(basedOn)) {
         const current = this.documents.get(uri)?.version ?? 0;
         if (current !== basedOn) {
            throw new ConflictError(uri, basedOn, current);
         }
      }
   }

   async updateModelDocument(args: TransferUpdateDocumentArgs<CanaryRoot>): Promise<TransferDocument<CanaryRoot, TransferDiagnostic>> {
      this.assertSessionMayWrite(args.clientId, args.uri);
      const text = typeof args.model === 'string' ? args.model : args.model.text;
      const existing = this.documents.get(args.uri);
      // The conflict gate, which is the property the based-on check probes.
      this.assertBasedOn(args.uri, args.basedOn);
      // An edit is any update that follows the first one for this URI, which is
      // the only notion of "edit" a fake with no grammar can hold.
      const isEdit = existing !== undefined;
      if (!(isEdit && this.defects.ignoreEdits)) {
         this.documents.set(args.uri, { text, version: (existing?.version ?? 0) + 1 });
      }
      const document = this.envelope(args.uri);
      const answer = this.defects.writeAnswersUnvalidated ? { ...document, diagnostics: [] } : document;
      if (this.watched.has(args.uri) || this.defects.notifiesBeforeSubscribe) {
         this.events.push({ document, sourceClientId: args.clientId, reason: this.defects.ownWriteRebuilt ? 'rebuilt' : 'changed' });
      }
      // The fake's stand-in for a dependency graph: editing `valid` "rebuilds"
      // the fixture's dependent. A Map holds no references, so the relation is
      // declared rather than derived — enough to exercise the check, and the
      // reason this canary cannot be mistaken for a real head.
      if (isEdit && args.uri === CANARY_VALID_URI && !this.defects.silentCascade) {
         const uris = this.defects.cascadeNamesWatched ? [CANARY_DEPENDENT_URI, args.uri] : [CANARY_DEPENDENT_URI];
         this.builds.push({ uris });
      }
      // Only the breaking text changes what the dependent shows, so only it
      // reaches the dependent's watcher; the framework's head suppresses the
      // rest.
      if (text === BREAKING_TEXT && args.uri === CANARY_VALID_URI && this.watched.has(CANARY_DEPENDENT_URI)) {
         const opener = [...this.sessions].find(([, opens]) => opens.has(CANARY_DEPENDENT_URI))?.[0];
         this.events.push({
            document: this.envelope(CANARY_DEPENDENT_URI),
            sourceClientId: this.defects.dependentCreditedToOpener && opener !== undefined ? opener : UNKNOWN_CLIENT_ID,
            reason: 'rebuilt'
         });
      }
      return answer;
   }

   async watchModelDocument(args: WatchModelDocumentArgs): Promise<void> {
      if (!this.defects.silentSubscriptions) {
         this.watched.add(args.uri);
      }
   }

   async unwatchModelDocument(args: WatchModelDocumentArgs): Promise<void> {
      this.watched.delete(args.uri);
   }

   async openModelDocument(args: OpenModelArgs): Promise<TransferDocument<CanaryRoot, TransferDiagnostic>> {
      const opens = this.sessions.get(args.clientId);
      if (!opens) {
         this.assertPlainClientAllowed(args.clientId);
      }
      opens?.add(args.uri);
      return this.envelope(args.uri);
   }

   async closeModelDocument(args: CloseModelArgs): Promise<void> {
      if (!this.sessions.has(args.clientId)) {
         this.assertPlainClientAllowed(args.clientId);
      }
      if (!this.defects.closeKeepsOpen) {
         this.sessions.get(args.clientId)?.delete(args.uri);
      }
      this.releaseIfClosed(args.uri);
   }

   async saveModelDocument(args: TransferSaveDocumentArgs<CanaryRoot>): Promise<TransferDocument<CanaryRoot, TransferDiagnostic>> {
      if (this.defects.saveOpensImplicitly) {
         this.sessions.get(args.clientId)?.add(args.uri);
      }
      await this.updateModelDocument(args);
      this.disk.set(args.uri, typeof args.model === 'string' ? args.model : args.model.text);
      return this.envelope(args.uri);
   }

   private envelope(uri: string): TransferDocument<CanaryRoot, TransferDiagnostic> {
      const stored = this.documents.get(uri);
      if (!stored) {
         // `root` absent is the documented answer for a URI the server does not
         // have, so this is an ordinary branch rather than an error.
         return TransferDocument.absent<CanaryRoot, TransferDiagnostic>(uri);
      }
      const diagnostics = this.defects.diagnosticsOnValid
         ? [canaryDiagnostic('the canary reports every model as broken', this.defects)]
         : this.defects.cleanInvalid
           ? []
           : diagnosticsFor(stored.text, this.defects);
      return {
         uri,
         version: asSnapshotVersion(this.defects.fractionalVersion ? stored.version + 0.5 : stored.version),
         root: { $type: this.defects.blankRootType ? '' : 'CanaryRoot', text: stored.text },
         diagnostics,
         dirty: !this.defects.neverDirty && stored.text !== this.disk.get(uri)
      };
   }
}

/** The single candidate the canary's reference surface offers. */
export const CANARY_CANDIDATE = 'CanaryTarget';

/** The fixture's `valid` URI, named so the cascade fake can recognise an edit to it. */
export const CANARY_VALID_URI = 'file:///one.x';
/** The fixture's `dependent` URI — the document the fake reports as cascade-rebuilt. */
export const CANARY_DEPENDENT_URI = 'file:///three.x';

/**
 * The fixture the canary server answers correctly. `edit.expect` reads the
 * root through {@link isCanaryRoot} rather than trusting the shape, because
 * the kit hands it `unknown`.
 */
export const CANARY_FIXTURE: LanguageFixture = {
   valid: { uri: CANARY_VALID_URI, languageId: 'x', text: VALID_TEXT },
   invalid: { uri: 'file:///two.x', languageId: 'x', text: INVALID_TEXT },
   dependent: { uri: CANARY_DEPENDENT_URI, languageId: 'x', text: VALID_TEXT },
   breakingEdit: BREAKING_TEXT,
   edit: { to: EDITED_TEXT, expect: root => isCanaryRoot(root) && root.text === EDITED_TEXT },
   // An explicit folder rather than the derived default: this fixture's `valid`
   // sits at the URI root, so deriving a parent from it yields the degenerate
   // `file://`. The derivation itself is covered where a real workspace makes it
   // meaningful (the order-flow example), not here.
   referenceQuery: {
      type: 'CanarySource',
      property: 'target',
      folderUri: 'file:///folder',
      expectCandidate: CANARY_CANDIDATE
   }
};
