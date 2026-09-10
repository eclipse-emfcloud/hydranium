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

import type { CloseModelArgs, OpenModelArgs, Project, TransferDiagnostic, TransferDocument, TransferElement } from '@hydranium/protocol';
import type {
   GetModelDocumentArgs,
   GetProjectForUriArgs,
   TransferDocumentUpdatedEvent,
   TransferSaveDocumentArgs,
   TransferUpdateDocumentArgs,
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

   private readonly documents = new Map<string, StoredDocument>();
   private readonly watched = new Set<string>();

   constructor(private readonly defects: CanaryDefects = {}) {}

   get proxy(): this {
      return this;
   }

   dispose(): void {
      this.documents.clear();
      this.watched.clear();
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
      return this.envelope(args.uri);
   }

   async updateModelDocument(args: TransferUpdateDocumentArgs<CanaryRoot>): Promise<TransferDocument<CanaryRoot, TransferDiagnostic>> {
      const text = typeof args.model === 'string' ? args.model : args.model.text;
      const existing = this.documents.get(args.uri);
      // An edit is any update that follows the first one for this URI, which is
      // the only notion of "edit" a fake with no grammar can hold.
      const isEdit = existing !== undefined;
      if (!(isEdit && this.defects.ignoreEdits)) {
         this.documents.set(args.uri, { text, version: (existing?.version ?? 0) + 1 });
      }
      const document = this.envelope(args.uri);
      if (this.watched.has(args.uri) || this.defects.notifiesBeforeSubscribe) {
         this.events.push({ document, sourceClientId: args.clientId, reason: 'changed' });
      }
      return document;
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
      return this.envelope(args.uri);
   }

   async closeModelDocument(_args: CloseModelArgs): Promise<void> {
      // Nothing to release: the canary holds no per-client state.
   }

   async saveModelDocument(args: TransferSaveDocumentArgs<CanaryRoot>): Promise<TransferDocument<CanaryRoot, TransferDiagnostic>> {
      return this.updateModelDocument(args);
   }

   private envelope(uri: string): TransferDocument<CanaryRoot, TransferDiagnostic> {
      const stored = this.documents.get(uri);
      if (!stored) {
         // `root` absent is the documented answer for a URI the server does not
         // have, so this is an ordinary branch rather than an error.
         return { uri, version: 0, diagnostics: [] };
      }
      const diagnostics = this.defects.diagnosticsOnValid
         ? [canaryDiagnostic('the canary reports every model as broken', this.defects)]
         : this.defects.cleanInvalid
           ? []
           : diagnosticsFor(stored.text, this.defects);
      return {
         uri,
         version: this.defects.fractionalVersion ? stored.version + 0.5 : stored.version,
         root: { $type: this.defects.blankRootType ? '' : 'CanaryRoot', text: stored.text },
         diagnostics
      };
   }
}

/**
 * The fixture the canary server answers correctly. `edit.expect` reads the
 * root through {@link isCanaryRoot} rather than trusting the shape, because
 * the kit hands it `unknown`.
 */
export const CANARY_FIXTURE: LanguageFixture = {
   valid: { uri: 'file:///one.x', languageId: 'x', text: VALID_TEXT },
   invalid: { uri: 'file:///two.x', languageId: 'x', text: INVALID_TEXT },
   edit: { to: EDITED_TEXT, expect: root => isCanaryRoot(root) && root.text === EDITED_TEXT }
};
