/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `@hydranium/conformance/data` slice — protocol conformance for the
 * data-server head. The driver port IS the protocol-native
 * {@link DataServerProtocol} proxy (plus the captured client notifications),
 * so no upstream wire-lib dep enters the kit and `DataServerHarness` satisfies
 * the port structurally with no adapter.
 */

import assert from 'node:assert/strict';
import {
   asModelVersion,
   FRAMEWORK_CLIENT_IDS,
   isConflictError,
   isDocumentNotOpenError,
   isDuplicateClientIdError,
   isReservedClientIdError,
   isSessionClosedError,
   ReferenceSource,
   SyntheticStep,
   TransferDocument,
   type TransferDiagnostic,
   type TransferElement,
   UNKNOWN_CLIENT_ID
} from '@hydranium/protocol';
import type {
   DataServerProtocol,
   ReferenceServerProtocol,
   TransferDocumentsBuiltEvent,
   TransferDocumentUpdatedEvent
} from '@hydranium/protocol/data';
import { type Harness, waitFor } from '@hydranium/protocol/testing';
import type { ConformanceCheck } from '../conformance-suite.js';
import { type LanguageFixture, resolveDeferred, resolveModel } from '../model.js';

/**
 * The data-server driver port — a live, connected, READY data-server exposed
 * through its protocol-native proxy plus the captured client-side
 * notifications. The kit names only `@hydranium/protocol` types, so a
 * `DataServerHarness` satisfies the port structurally (it has `proxy` +
 * `events`, `builds` and `dispose`) with NO adapter. `extends Harness` gives the kit the
 * universal `dispose()` teardown.
 *
 * The kit seeds documents purely through the proxy, as client sessions: it
 * registers one with `createSession`, opens the document, or creates it with
 * `createModelDocument` when there is no file to open, and writes it. So the
 * head under test must implement sessions, and the slice needs no
 * services-level open hook. The adopter only has to stand the server up READY
 * in its `connect` — see {@link DataConformanceOptions.connect}.
 */
export interface DataConformanceDriver<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic
> extends Harness {
   readonly proxy: DataServerProtocol<TTransfer, TDiagnostic>;
   /** Captured `onDocumentUpdated` events, in append order. */
   readonly events: ReadonlyArray<TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>>;
   /** Captured `onDocumentsBuilt` events, append order — the cascade check's observation target. */
   readonly builds: ReadonlyArray<TransferDocumentsBuiltEvent>;
   /**
    * The opt-in reference surface, when the head serves it.
    *
    * Separate from {@link proxy} because `ReferenceServerProtocol` is NOT part
    * of `DataServerProtocol` — a head may serve documents and no references at
    * all. Absent means the reference check reports skipped with a named reason
    * rather than failing a head that never claimed the surface.
    */
   readonly references?: ReferenceServerProtocol;
}

/** Options for `runDataConformance`. */
export interface DataConformanceOptions<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic = TransferDiagnostic> {
   /**
    * Establish a freshly-wired, connected, READY data-server driver. Called
    * once per check for isolation; the kit disposes it after the check. The
    * adopter must initialise the workspace before returning, so `waitForReady`
    * resolves rather than hanging.
    *
    * Some checks save documents beside each fixture's `valid`, and nothing in
    * the protocol deletes a file, so give each check a workspace the kit may
    * write to and throw away.
    */
   readonly connect: () => DataConformanceDriver<TTransfer, TDiagnostic> | Promise<DataConformanceDriver<TTransfer, TDiagnostic>>;
   /** Per-language fixtures; the grammar-bearing checks run once per language. */
   readonly languages: ReadonlyArray<LanguageFixture>;
   /**
    * Set this when the head under test HAS a project tier. Supplying it IS the
    * claim that `getProjects` answers at least one project, so an empty array
    * becomes a failure rather than a vacuous pass.
    *
    * Left unset the claim is not made and the check reports skipped with a
    * named reason, because `[]` is the documented answer for a head with no
    * project tier (`UNQUALIFIED_PROJECT_REFERENCE` everywhere) — indistinguishable
    * from "never implemented" without the adopter saying which it is.
    */
   readonly expectsProjects?: boolean;
   /**
    * Open another connection to the same server as `driver`, for the check
    * that a connection's sessions end with it while the server lives on. That
    * check disposes `driver` and needs its `dispose` to close the connection as
    * the server sees it. Absent, the check reports skipped.
    */
   readonly attach?: (
      driver: DataConformanceDriver<TTransfer, TDiagnostic>
   ) => DataConformanceDriver<TTransfer, TDiagnostic> | Promise<DataConformanceDriver<TTransfer, TDiagnostic>>;
   /** Suite title override. Default `'conformance: data-server'`. */
   readonly suiteTitle?: string;
}

/** Client id the kit subscribes under; a watch needs no session. */
const SUBSCRIBER = 'conformance-subscriber';

/**
 * A fresh session id per check. A fixed one would be refused as a duplicate
 * by a head whose `connect` reuses one server across checks, whenever an
 * earlier check failed before ending its session.
 */
function sessionId(label = 'conformance-session'): string {
   return `${label}#${globalThis.crypto.randomUUID()}`;
}

/** Register a session under a fresh id labelled `label`, and answer the id. */
async function startSession<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic>(
   driver: DataConformanceDriver<TTransfer, TDiagnostic>,
   label: string
): Promise<string> {
   const clientId = sessionId(label);
   await driver.proxy.createSession({ clientId, label });
   return clientId;
}

/**
 * Create `model` for the session `clientId`, then open it, since a fixture may
 * name a document that exists nowhere but in the kit. A failed create is
 * dropped when the open succeeds, so a head whose create is broken fails only
 * the create check; an open that fails reports both failures.
 */
async function openOrCreate<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic>(
   driver: DataConformanceDriver<TTransfer, TDiagnostic>,
   clientId: string,
   model: { readonly uri: string; readonly text: string }
): Promise<void> {
   const created = await rejectionOf(driver.proxy.createModelDocument({ uri: model.uri, clientId, text: model.text }));
   const opened = await rejectionOf(driver.proxy.openModelDocument({ uri: model.uri, clientId }));
   if (opened !== undefined) {
      throw new Error(`Could not seed ${model.uri}: ${String(opened)}; creating it failed with ${String(created)}`, { cause: opened });
   }
}

/**
 * Write `model` to its URI under a new session labelled `label`, and answer the
 * session's id. The session keeps the document open until the driver is
 * disposed: closing it would revert the document to its file, which holds
 * another text or none.
 */
async function seed<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic>(
   driver: DataConformanceDriver<TTransfer, TDiagnostic>,
   model: { readonly uri: string; readonly text: string },
   label = 'conformance-seeder'
): Promise<string> {
   const clientId = await startSession(driver, label);
   await openOrCreate(driver, clientId, model);
   await driver.proxy.updateModelDocument({ uri: model.uri, clientId, model: model.text, baseVersion: 'any' });
   return clientId;
}

/** A new session labelled `label` with `uri` open, for a write after the seed; answers its id. */
async function openAs<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic>(
   driver: DataConformanceDriver<TTransfer, TDiagnostic>,
   uri: string,
   label = 'conformance-author'
): Promise<string> {
   const clientId = await startSession(driver, label);
   await driver.proxy.openModelDocument({ uri, clientId });
   return clientId;
}

/**
 * Register `clientId` on `driver`, retrying while the server still refuses it
 * as a duplicate, for up to `boundMs`; the last refusal is thrown.
 */
async function registerWithin<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic>(
   driver: DataConformanceDriver<TTransfer, TDiagnostic>,
   clientId: string,
   boundMs: number
): Promise<void> {
   const deadline = Date.now() + boundMs;
   for (;;) {
      const refusal = await rejectionOf(driver.proxy.createSession({ clientId }));
      if (refusal === undefined) {
         return;
      }
      if (!isDuplicateClientIdError(refusal) || Date.now() >= deadline) {
         throw refusal;
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
   }
}

/** A URI beside `uri` in its folder, its file name prefixed with `prefix`, so the language and project stay the fixture's. */
function siblingOf(uri: string, prefix: string): string {
   const slash = uri.lastIndexOf('/') + 1;
   return `${uri.slice(0, slash)}${prefix}${uri.slice(slash)}`;
}

/**
 * Read `uri` until `settled` holds of the answer, for up to two seconds; fail
 * with `message` after that. For an effect a head may finish after its request
 * answered, such as the revert of a last close. A refused read reaches
 * `settled` as `undefined`.
 */
async function readUntil<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic>(
   driver: DataConformanceDriver<TTransfer, TDiagnostic>,
   uri: string,
   settled: (document: TransferDocument<TTransfer, TDiagnostic> | undefined) => boolean,
   message: string
): Promise<void> {
   const deadline = Date.now() + 2_000;
   while (!settled(await driver.proxy.getModelDocument({ uri }).catch(() => undefined))) {
      assert.ok(Date.now() < deadline, message);
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
   }
}

/** Settle `promise` into its rejection, or `undefined` when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
   return promise.then(
      () => undefined,
      (error: unknown) => error
   );
}

/**
 * Build the data-server check battery: server-level checks once, then the
 * grammar-bearing checks per language. Each check connects a fresh driver
 * and disposes it, so checks never interfere. Exported for the kit's own
 * unit tests; adopters call `runDataConformance`.
 *
 * `LanguageFixture.edit` is read HERE and nowhere else in the kit, and is
 * optional: every check that needs one reports skipped when it is absent. See
 * {@link LanguageFixture} for which slice reads which field.
 */
export function buildDataChecks<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic = TransferDiagnostic>(
   options: DataConformanceOptions<TTransfer, TDiagnostic>
): ConformanceCheck[] {
   const { connect, attach, expectsProjects } = options;
   const checks: ConformanceCheck[] = [];

   // Split from `waitForReady` so a failure names which of the two broke.
   //
   // SHAPE ONLY: an empty array is the documented answer for a head with no
   // project tier, so "returns `[]`" passes here and is indistinguishable from
   // "never implemented". The discriminating part is the element-type assertion
   // (it fails a head answering with the wrong element type, which the bare
   // `Array.isArray` it replaced could not) plus the separate emptiness check
   // below, which only an adopter's `expectsProjects` can license.
   checks.push({
      title: 'getProjects answers an array of well-formed projects',
      body: async () => {
         const driver = await connect();
         try {
            const projects = await driver.proxy.getProjects();
            assert.ok(Array.isArray(projects), 'getProjects did not return an array');
            for (const project of projects) {
               assert.ok(
                  typeof project?.id === 'string' && project.id.length > 0,
                  `getProjects returned a project with no id: ${JSON.stringify(project)}`
               );
               // Type, not emptiness: the empty string is
               // `UNQUALIFIED_PROJECT_REFERENCE`, the documented value for a
               // project that does not qualify names, and the framework's own
               // reference example uses it. Requiring non-empty here failed
               // that example and would have failed every adopter taking the
               // documented default.
               assert.ok(typeof project.referenceName === 'string', `project ${project.id} has no referenceName`);
            }
            const ids = projects.map(project => project.id);
            assert.strictEqual(new Set(ids).size, ids.length, `getProjects returned duplicate project ids: ${ids.join(', ')}`);
         } finally {
            driver.dispose();
         }
      }
   });

   // Separate from the shape check so a failure names which claim broke, and
   // gated because only the adopter knows whether their head has a project
   // tier at all. Planned either way — reported as skipped with a reason
   // rather than silently absent, which is what distinguishes an opt-out from
   // lost coverage.
   checks.push({
      title: 'getProjects answers at least one project (projects expected)',
      skipReason: expectsProjects
         ? undefined
         : 'options supplied no `expectsProjects` (an empty project list is the documented answer for a head with no project tier)',
      body: expectsProjects
         ? async () => {
              const driver = await connect();
              try {
                 const projects = await driver.proxy.getProjects();
                 assert.ok(
                    projects.length > 0,
                    'getProjects returned an empty array although `expectsProjects` claims the head has a project tier'
                 );
              } finally {
                 driver.dispose();
              }
           }
         : undefined
   });

   checks.push({
      title: 'createSession refuses an id already live, and frees it once the session ends',
      body: async () => {
         const driver = await connect();
         try {
            const clientId = await startSession(driver, 'conformance-session');
            const duplicate = await rejectionOf(driver.proxy.createSession({ clientId }));
            assert.ok(isDuplicateClientIdError(duplicate), `a second createSession under a live id was not refused: ${String(duplicate)}`);
            await driver.proxy.closeSession({ clientId });
            // The other half: a head that refused every id would pass the
            // assertion above on its own.
            await driver.proxy.createSession({ clientId });
            await driver.proxy.closeSession({ clientId });
         } finally {
            driver.dispose();
         }
      }
   });

   checks.push({
      title: 'createSession refuses every id the framework reserves, not as a duplicate',
      body: async () => {
         const driver = await connect();
         try {
            // Every id: a head that refuses only some passes a single case. A
            // reserved id never frees up, so a caller retrying on a duplicate
            // has to be able to tell this refusal apart.
            for (const clientId of FRAMEWORK_CLIENT_IDS) {
               const refusal = await rejectionOf(driver.proxy.createSession({ clientId }));
               assert.ok(
                  isReservedClientIdError(refusal),
                  `createSession under the reserved id ${clientId} was not refused as reserved: ${String(refusal)}`
               );
            }
         } finally {
            driver.dispose();
         }
      }
   });

   checks.push({
      title: 'waitForReady resolves rather than hanging or rejecting',
      body: async () => {
         const driver = await connect();
         try {
            // Resolves `Promise<void>`, and over JSON-RPC a void response comes
            // back as `null` — so the value carries no information and only the
            // fact that it settles at all is assertable here.
            await driver.proxy.waitForReady();
         } finally {
            driver.dispose();
         }
      }
   });

   for (const language of options.languages) {
      const { valid, invalid, edit, dependent } = language;
      const tag = `[${valid.languageId}]`;

      checks.push({
         title: `getModelDocument(valid) returns a coherent envelope ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               // Resolved AFTER `connect`, which is the whole point of allowing a
               // thunk: the fixture may name a workspace `connect` just created.
               const model = resolveModel(valid);
               await seed(driver, model);
               // `includeDiagnostics` for the same reason the invalid check
               // passes it: a synchronous read settles at the integrity-settled
               // phase, so an empty array without it can mean "validation has
               // not run" rather than "the document is clean".
               const document = await driver.proxy.getModelDocument({ uri: model.uri, includeDiagnostics: true });
               assert.strictEqual(document.uri, model.uri);
               // The SHAPE, not truthiness: `{}` is truthy, so a head answering
               // a shaped-but-contentless envelope for a document it did parse
               // would pass. `$type` is the one field every TransferElement
               // carries, so it is assertable with no fixture knowledge.
               const { model: snapshot } = TransferDocument.assertLoaded(document);
               const { root } = snapshot;
               assert.ok(
                  typeof root.$type === 'string' && root.$type.length > 0,
                  `getModelDocument(valid) returned a root with no $type: ${JSON.stringify(root)}`
               );
               // `version` is the conflict token every later update gates on, so
               // an envelope that omits it is unusable however good the root is.
               assert.ok(
                  Number.isInteger(snapshot.version),
                  `getModelDocument(valid) returned a non-integer version: ${String(snapshot.version)}`
               );
               assert.strictEqual(typeof snapshot.hash, 'string', 'getModelDocument(valid) returned a model with no hash');
               assert.deepStrictEqual(snapshot.diagnostics, []);
            } finally {
               driver.dispose();
            }
         }
      });

      checks.push({
         title: `getModelDocument(invalid) reports at least one diagnostic ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               const model = resolveModel(invalid);
               await seed(driver, model);
               // Diagnostics are a validation-phase product; a synchronous read settles at the
               // integrity-settled phase by default, so request validation explicitly here.
               // Safe despite `includeDiagnostics` waiting rather than forcing a build: the
               // update above has already driven this document through validation.
               const document = await driver.proxy.getModelDocument({ uri: model.uri, includeDiagnostics: true });
               assert.ok((document.model?.diagnostics?.length ?? 0) >= 1, 'getModelDocument(invalid) reported no diagnostics');
            } finally {
               driver.dispose();
            }
         }
      });

      checks.push({
         title: `a diagnostic carrying a framework message code also carries its params ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               const model = resolveModel(invalid);
               await seed(driver, model);
               const document = await driver.proxy.getModelDocument({ uri: model.uri, includeDiagnostics: true });

               // Conditional rather than fixture-driven, and deliberately so: what
               // an `invalid` fixture provokes is the adopter's choice, and a
               // syntactic error legitimately carries no identity at all. The
               // invariant is that the identity travels WHOLE or not — a `code`
               // without `params` is the half-state that renders a translated
               // template with its placeholders left standing, and it is
               // reachable only by overriding `toTransferDiagnostic`.
               const halfIdentities = (document.model?.diagnostics ?? []).filter(
                  diagnostic =>
                     typeof diagnostic.code === 'string' && diagnostic.code.startsWith('hydranium/') && diagnostic.params === undefined
               );
               assert.deepStrictEqual(
                  halfIdentities.map(diagnostic => diagnostic.code),
                  [],
                  'diagnostics carry a framework message code with no params, so a translating surface cannot render them'
               );
            } finally {
               driver.dispose();
            }
         }
      });

      checks.push({
         title: `a session writes only a document it has open ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               const model = resolveModel(valid);
               await seed(driver, model);
               const clientId = await startSession(driver, 'conformance-session');
               const write = { uri: model.uri, clientId, model: model.text, baseVersion: 'any' } as const;

               const unopened = await rejectionOf(driver.proxy.updateModelDocument(write));
               assert.ok(isDocumentNotOpenError(unopened), `a session wrote a document it never opened: ${String(unopened)}`);
               await driver.proxy.openModelDocument({ uri: model.uri, clientId });
               await driver.proxy.updateModelDocument(write);
               await driver.proxy.closeModelDocument({ uri: model.uri, clientId });
               const closed = await rejectionOf(driver.proxy.updateModelDocument(write));
               assert.ok(isDocumentNotOpenError(closed), `a session wrote a document after closing it: ${String(closed)}`);
               await driver.proxy.closeSession({ clientId });
            } finally {
               driver.dispose();
            }
         }
      });

      checks.push({
         title: `a session saves only a document it has open ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               const model = resolveModel(valid);
               await seed(driver, model);
               const clientId = await startSession(driver, 'conformance-session');
               const save = { uri: model.uri, clientId, model: model.text, baseVersion: 'any' } as const;

               const unopened = await rejectionOf(driver.proxy.saveModelDocument(save));
               assert.ok(isDocumentNotOpenError(unopened), `a session saved a document it never opened: ${String(unopened)}`);
               // The other half: a head refusing every session save would pass
               // the assertion above on its own.
               await driver.proxy.openModelDocument({ uri: model.uri, clientId });
               await driver.proxy.saveModelDocument(save);
               await driver.proxy.closeSession({ clientId });
            } finally {
               driver.dispose();
            }
         }
      });

      checks.push({
         title: `a document request under an id no session was registered for fails ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               const model = resolveModel(valid);
               await seed(driver, model);
               const clientId = sessionId('conformance-unregistered');

               // Opened or written under an id that is no session, a document
               // would stay open for a client whose end nothing ever reports.
               const open = await rejectionOf(driver.proxy.openModelDocument({ uri: model.uri, clientId }));
               assert.ok(isSessionClosedError(open), `a document opened under an unregistered id: ${String(open)}`);
               const write = await rejectionOf(
                  driver.proxy.updateModelDocument({ uri: model.uri, clientId, model: model.text, baseVersion: 'any' })
               );
               assert.ok(isSessionClosedError(write), `a document was written under an unregistered id: ${String(write)}`);
            } finally {
               driver.dispose();
            }
         }
      });

      checks.push({
         title: `ending a connection ends its sessions ${tag}`,
         skipReason: attach ? undefined : 'options supply no `attach` (a second connection to the same server outlives the ended one)',
         body: attach
            ? async () => {
                 const driver = await connect();
                 let driverOpen = true;
                 try {
                    const model = resolveModel(valid);
                    await seed(driver, model);
                    const clientId = await startSession(driver, 'conformance-session');
                    await driver.proxy.openModelDocument({ uri: model.uri, clientId });
                    const sibling = await attach(driver);
                    try {
                       driverOpen = false;
                       driver.dispose();
                       // Refused as a duplicate while the ended connection's
                       // session lives on, which over a socket it does until the
                       // server has seen the close; so retried, within a bound.
                       await registerWithin(sibling, clientId, 2_000);
                       const write = await rejectionOf(
                          sibling.proxy.updateModelDocument({ uri: model.uri, clientId, model: model.text, baseVersion: 'any' })
                       );
                       assert.ok(isDocumentNotOpenError(write), `a document stayed open after its connection ended: ${String(write)}`);
                       await sibling.proxy.closeSession({ clientId });
                    } finally {
                       sibling.dispose();
                    }
                 } finally {
                    if (driverOpen) {
                       driver.dispose();
                    }
                 }
              }
            : undefined
      });

      checks.push({
         title: `closeSession closes every document the session had open ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               const model = resolveModel(valid);
               await seed(driver, model);
               const clientId = await startSession(driver, 'conformance-session');
               await driver.proxy.openModelDocument({ uri: model.uri, clientId });

               await driver.proxy.closeSession({ clientId });

               // Observed through a new session under the same id: one that
               // inherited the ended session's open would write without opening.
               await driver.proxy.createSession({ clientId });
               const write = await rejectionOf(
                  driver.proxy.updateModelDocument({ uri: model.uri, clientId, model: model.text, baseVersion: 'any' })
               );
               assert.ok(isDocumentNotOpenError(write), `a document stayed open after its session ended: ${String(write)}`);
               await driver.proxy.closeSession({ clientId });
            } finally {
               driver.dispose();
            }
         }
      });

      checks.push({
         title: `createModelDocument creates a document open for the session, and refuses one that exists ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               const model = resolveModel(valid);
               await seed(driver, model);
               const clientId = await startSession(driver, 'conformance-session');
               const createdUri = siblingOf(model.uri, 'conformance-created-');

               const created = await driver.proxy.createModelDocument({ uri: createdUri, clientId, text: model.text });
               const { model: createdModel } = TransferDocument.assertLoaded(created);
               // Written without an open: only the create can have opened it.
               await driver.proxy.updateModelDocument({ uri: createdUri, clientId, model: model.text, baseVersion: createdModel.version });

               const existing = await rejectionOf(driver.proxy.createModelDocument({ uri: model.uri, clientId, text: model.text }));
               assert.ok(existing !== undefined, `createModelDocument accepted ${model.uri}, which already exists`);
               await driver.proxy.closeSession({ clientId });
            } finally {
               driver.dispose();
            }
         }
      });

      checks.push({
         title: `a write of the invalid model answers with its diagnostics ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               const model = resolveModel(invalid);
               const clientId = await startSession(driver, 'conformance-session');
               await openOrCreate(driver, clientId, model);
               // Another text first, so that the invalid one is a change: the
               // answer to a write that changes nothing can carry the
               // diagnostics of an earlier validation. This does not prove the
               // answer waited for this write's validation, only that it
               // carries diagnostics at all.
               const firstText = resolveDeferred(valid.text);
               await driver.proxy.updateModelDocument({ uri: model.uri, clientId, model: firstText, baseVersion: 'any' });
               // The answer alone, with no read after it: a caller that shows
               // the problems of what it wrote should not need a second
               // request, and a read could find a later write's state.
               const answer = await driver.proxy.updateModelDocument({ uri: model.uri, clientId, model: model.text, baseVersion: 'any' });
               assert.ok((answer.model?.diagnostics?.length ?? 0) >= 1, 'writing the invalid model answered with no diagnostics');
               await driver.proxy.closeSession({ clientId });
            } finally {
               driver.dispose();
            }
         }
      });

      checks.push({
         title: `a created document never saved leaves with its last close ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               const model = resolveModel(valid);
               const uri = siblingOf(model.uri, 'conformance-unsaved-');
               const clientId = await startSession(driver, 'conformance-session');
               await driver.proxy.createModelDocument({ uri, clientId, text: model.text });
               // Served before the close, so an envelope without a model after
               // it is the close's doing and not the head's answer for every
               // created document.
               TransferDocument.assertLoaded(await driver.proxy.getModelDocument({ uri }));
               await driver.proxy.closeSession({ clientId });
               // It has no file to go back to, so no text is left to serve, and
               // the protocol answers a URI with no document with an envelope
               // that has no model, not with a refusal.
               await readUntil(
                  driver,
                  uri,
                  document => document !== undefined && !TransferDocument.isLoaded(document),
                  `${uri}, created and never saved, was not answered with an envelope without a model after its last close`
               );
            } finally {
               driver.dispose();
            }
         }
      });

      checks.push({
         title: `a document is dirty while its text differs from its file, and clean once saved ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               const model = resolveModel(valid);
               // Only `dirty` is asserted, so any second text serves.
               const unsaved = resolveDeferred(invalid.text);
               const uri = siblingOf(model.uri, `conformance-saved-${globalThis.crypto.randomUUID()}-`);
               const clientId = await startSession(driver, 'conformance-session');
               await driver.proxy.createModelDocument({ uri, clientId, text: model.text });

               const saved = await driver.proxy.saveModelDocument({ uri, clientId, model: model.text, baseVersion: 'any' });
               assert.strictEqual(saved.text?.dirty, false, `the save of ${uri} answered dirty: ${String(saved.text?.dirty)}, not false`);
               const edited = await driver.proxy.updateModelDocument({ uri, clientId, model: unsaved, baseVersion: 'any' });
               assert.strictEqual(
                  edited.text?.dirty,
                  true,
                  `an unsaved write of ${uri} answered dirty: ${String(edited.text?.dirty)}, not true`
               );
               const resaved = await driver.proxy.saveModelDocument({ uri, clientId, model: unsaved, baseVersion: 'any' });
               assert.strictEqual(
                  resaved.text?.dirty,
                  false,
                  `the second save of ${uri} answered dirty: ${String(resaved.text?.dirty)}, not false`
               );
               await driver.proxy.closeSession({ clientId });
            } finally {
               driver.dispose();
            }
         }
      });

      checks.push({
         title: `a document's text hash is equal for equal text and differs for different text ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               const model = resolveModel(valid);
               // Only the text is compared, so any second text serves.
               const other = resolveDeferred(invalid.text);
               const uri = siblingOf(model.uri, `conformance-hashed-${globalThis.crypto.randomUUID()}-`);
               const clientId = await startSession(driver, 'conformance-session');
               const created = await driver.proxy.createModelDocument({ uri, clientId, text: model.text });
               const edited = await driver.proxy.updateModelDocument({ uri, clientId, model: other, baseVersion: 'any' });
               // Back to the first text at a later version: the hash follows
               // the text, which is what a client compares across a revert.
               const restored = await driver.proxy.updateModelDocument({ uri, clientId, model: model.text, baseVersion: 'any' });

               assert.strictEqual(typeof created.text?.hash, 'string', `the create of ${uri} answered with no text hash`);
               assert.notStrictEqual(
                  edited.text?.hash,
                  created.text?.hash,
                  `${uri} hashed a different text alike: ${String(edited.text?.hash)}`
               );
               assert.strictEqual(
                  restored.text?.hash,
                  created.text?.hash,
                  `${uri} hashed its first text again as ${String(restored.text?.hash)}`
               );
               const read = await driver.proxy.getModelDocument({ uri });
               assert.strictEqual(read.text?.hash, restored.text?.hash, `a read of ${uri} hashed its text as ${String(read.text?.hash)}`);
               const absent = await driver.proxy.getModelDocument({
                  uri: siblingOf(model.uri, `conformance-absent-${globalThis.crypto.randomUUID()}-`)
               });
               assert.strictEqual(absent.text, undefined, `an envelope with no document carried text ${JSON.stringify(absent.text)}`);
               await driver.proxy.closeSession({ clientId });
            } finally {
               driver.dispose();
            }
         }
      });

      // The create-dialog query, and the reason it is its own check: it is the
      // only request a head receives whose URI names no file. Everything else
      // in this battery addresses a document, so a head that routes purely by
      // URI extension passes all of them and still cannot open a create dialog.
      //
      // Doubly opt-in — the fixture must name a query AND the driver must serve
      // the reference surface — because either half missing means the head never
      // claimed this behaviour. The reasons are reported separately so a skip
      // says which half is absent.
      const referenceQuery = language.referenceQuery;
      const referenceSkipReason = !referenceQuery
         ? 'fixture supplies no `referenceQuery` (omit it if this language has no create-element dialog)'
         : undefined;

      checks.push({
         title: `findReferenceCandidates answers for a synthetic source at a folder URI ${tag}`,
         skipReason: referenceSkipReason,
         body: referenceQuery
            ? async () => {
                 const driver = await connect();
                 try {
                    if (!driver.references) {
                       // Checked here rather than in `skipReason`: the driver only
                       // exists once `connect` has run, and skip reasons are
                       // computed while the battery is being planned.
                       return;
                    }
                    const model = resolveModel(valid);
                    await seed(driver, model);

                    // Default to the folder holding the valid model: a sibling of
                    // it is where a create flow would put the new file.
                    const folderUri = referenceQuery.folderUri
                       ? resolveDeferred(referenceQuery.folderUri)
                       : model.uri.slice(0, model.uri.lastIndexOf('/'));
                    assert.ok(
                       folderUri.length > 0 && folderUri !== model.uri,
                       `could not derive a folder URI from ${model.uri}; supply referenceQuery.folderUri`
                    );

                    const candidates = await driver.references.findReferenceCandidates({
                       source: ReferenceSource.synthetic(folderUri, referenceQuery.type),
                       syntheticPath: referenceQuery.path?.map(([containerProperty, type]) => SyntheticStep.of(containerProperty, type)),
                       property: referenceQuery.property
                    });

                    // The expected label, not merely a non-empty array: the defect
                    // this guards against answers `[]`, and an empty result is
                    // also what a head with a genuinely empty index answers, so
                    // only a named candidate tells the two apart.
                    const labels = candidates.map(candidate => candidate.label);
                    assert.ok(
                       labels.includes(referenceQuery.expectCandidate),
                       `findReferenceCandidates at the folder ${folderUri} did not offer ${JSON.stringify(
                          referenceQuery.expectCandidate
                       )}; got [${labels.join(', ')}]`
                    );
                 } finally {
                    driver.dispose();
                 }
              }
            : undefined
      });

      // Opt-in: a check that needs a second, observably different model text
      // takes it from `edit`, and skips without one.
      const editSkipReason = 'fixture supplies no `edit` (data-slice only; omit it if this language is not driven through the data head)';

      checks.push({
         title: `updateModelDocument applies an edit a follow-up get reflects ${tag}`,
         skipReason: edit ? undefined : editSkipReason,
         body: edit
            ? async () => {
                 const driver = await connect();
                 try {
                    const model = resolveModel(valid);
                    const seeder = await seed(driver, model);
                    await driver.proxy.updateModelDocument({
                       uri: model.uri,
                       clientId: seeder,
                       model: resolveDeferred(edit.to),
                       baseVersion: 'any'
                    });
                    const document = await driver.proxy.getModelDocument({ uri: model.uri });
                    assert.ok(
                       edit.expect(document.model?.root),
                       'edit.expect(root) was false — the edit was not reflected by a follow-up get'
                    );
                 } finally {
                    driver.dispose();
                 }
              }
            : undefined
      });

      checks.push({
         title: `updateModelDocument arms the conflict gate on a base version ${tag}`,
         skipReason: edit ? undefined : editSkipReason,
         body: edit
            ? async () => {
                 const driver = await connect();
                 try {
                    const model = resolveModel(valid);
                    const seeder = await seed(driver, model);
                    const author = await openAs(driver, model.uri);

                    // The version the gate is meant to accept, read BEFORE the
                    // foreign edit that supersedes it.
                    const stale = await driver.proxy.getModelDocument({ uri: model.uri });
                    await driver.proxy.updateModelDocument({
                       uri: model.uri,
                       clientId: seeder,
                       model: resolveDeferred(edit.to),
                       baseVersion: 'any'
                    });

                    let rejection: unknown;
                    await driver.proxy
                       .updateModelDocument({
                          uri: model.uri,
                          clientId: author,
                          model: model.text,
                          baseVersion: TransferDocument.assertLoaded(stale).model.version
                       })
                       .catch((error: unknown) => {
                          rejection = error;
                       });
                    assert.ok(
                       isConflictError(rejection),
                       `a write based on the superseded v${String(stale.model?.version)} was not refused: ${String(rejection)}`
                    );

                    // The other half, and it is not optional: a head that refused
                    // EVERY write would satisfy the assertion above on its own, so
                    // the gate has to be shown accepting a current snapshot too.
                    const fresh = await driver.proxy.getModelDocument({ uri: model.uri });
                    await driver.proxy.updateModelDocument({
                       uri: model.uri,
                       clientId: author,
                       model: resolveDeferred(edit.to),
                       baseVersion: TransferDocument.assertLoaded(fresh).model.version
                    });
                 } finally {
                    driver.dispose();
                 }
              }
            : undefined
      });

      checks.push({
         title: `the last close drops a document's unsaved text and keeps what its save wrote ${tag}`,
         skipReason: edit ? undefined : editSkipReason,
         body: edit
            ? async () => {
                 const driver = await connect();
                 try {
                    const model = resolveModel(valid);
                    const edited = resolveDeferred(edit.to);
                    const uri = siblingOf(model.uri, `conformance-reverted-${globalThis.crypto.randomUUID()}-`);
                    const writer = await startSession(driver, 'conformance-writer');
                    // Created with the edit, so that going back to the created
                    // text instead of the saved one shows.
                    await driver.proxy.createModelDocument({ uri, clientId: writer, text: edited });
                    const saved = await driver.proxy.saveModelDocument({ uri, clientId: writer, model: model.text, baseVersion: 'any' });
                    assert.ok(
                       !edit.expect(saved.model?.root),
                       'edit.expect holds of the valid text, so this check cannot tell the edit apart'
                    );
                    const reader = await openAs(driver, uri, 'conformance-reader');
                    await driver.proxy.updateModelDocument({ uri, clientId: writer, model: edited, baseVersion: 'any' });

                    // Not the last close: the reader still shows the writer's
                    // text. Read at once, so a head that reverts after answering
                    // could still pass this half.
                    await driver.proxy.closeSession({ clientId: writer });
                    const held = await driver.proxy.getModelDocument({ uri });
                    assert.ok(edit.expect(held.model?.root), `closing one of two sessions dropped the unsaved text of ${uri}`);

                    await driver.proxy.closeSession({ clientId: reader });
                    await readUntil(
                       driver,
                       uri,
                       document => document?.model !== undefined && !edit.expect(document.model.root),
                       `${uri} did not go back to the text its save wrote after its last close`
                    );
                 } finally {
                    driver.dispose();
                 }
              }
            : undefined
      });

      // Opt-in twice over: the cascade needs an edit to provoke it AND a second
      // document that references the first to be provoked.
      const cascadeSkipReason =
         'fixture supplies no `dependent` (a document referencing `valid`), so no cascade can be provoked over the protocol';

      checks.push({
         title: `updateModelDocuments writes a set all or none ${tag}`,
         skipReason:
            edit && dependent
               ? undefined
               : dependent
                 ? editSkipReason
                 : 'fixture supplies no `dependent`, the second document a set needs besides `valid`',
         body:
            edit && dependent
               ? async () => {
                    const driver = await connect();
                    try {
                       const model = resolveModel(valid);
                       const other = resolveModel(dependent);
                       await seed(driver, model);
                       await seed(driver, other);
                       const clientId = await startSession(driver, 'conformance-session');
                       const { model: first } = TransferDocument.assertLoaded(
                          await driver.proxy.openModelDocument({ uri: model.uri, clientId })
                       );
                       const { model: second } = TransferDocument.assertLoaded(
                          await driver.proxy.openModelDocument({ uri: other.uri, clientId })
                       );
                       const edited = resolveDeferred(edit.to);

                       // The stale member comes LAST, so a head that checks and
                       // applies one document at a time has applied the first.
                       const stale = await rejectionOf(
                          driver.proxy.updateModelDocuments({
                             clientId,
                             updates: [
                                { uri: model.uri, model: edited, baseVersion: first.version },
                                { uri: other.uri, model: other.text, baseVersion: asModelVersion(second.version + 1) }
                             ]
                          })
                       );
                       assert.ok(isConflictError(stale), `a set with a stale member was not refused: ${String(stale)}`);
                       const untouched = await driver.proxy.getModelDocument({ uri: model.uri });
                       assert.strictEqual(untouched.model?.version, first.version, 'a refused set applied its first document');

                       await driver.proxy.updateModelDocuments({
                          clientId,
                          updates: [
                             { uri: model.uri, model: edited, baseVersion: first.version },
                             { uri: other.uri, model: other.text, baseVersion: second.version }
                          ]
                       });
                       const applied = await driver.proxy.getModelDocument({ uri: model.uri });
                       assert.ok(edit.expect(applied.model?.root), 'edit.expect(root) was false — a current set was not applied');
                       await driver.proxy.closeSession({ clientId });
                    } finally {
                       driver.dispose();
                    }
                 }
               : undefined
      });

      checks.push({
         title: `editing a document reports its unwatched dependent as built ${tag}`,
         skipReason: edit && dependent ? undefined : dependent ? editSkipReason : cascadeSkipReason,
         body:
            edit && dependent
               ? async () => {
                    const driver = await connect();
                    try {
                       const model = resolveModel(valid);
                       const other = resolveModel(dependent);
                       await seed(driver, model);
                       await seed(driver, other);
                       // Watch ONLY the referenced document. The dependent is left
                       // unwatched on purpose: that is the state in which no other
                       // channel can report it, and the state a workspace view is in
                       // for every document it displays without opening.
                       await driver.proxy.watchModelDocument({ uri: model.uri, clientId: SUBSCRIBER });
                       const author = await openAs(driver, model.uri);
                       const before = driver.builds.length;

                       await driver.proxy.updateModelDocument({
                          uri: model.uri,
                          clientId: author,
                          model: resolveDeferred(edit.to),
                          baseVersion: 'any'
                       });

                       await waitFor(() => driver.builds.slice(before).some(event => event.uris.includes(other.uri)), {
                          message: `no onDocumentsBuilt event named ${other.uri} after editing the document it references`
                       });
                       const reported = driver.builds.slice(before).flatMap(event => [...event.uris]);
                       // The watched document is excluded: its watcher already heard
                       // about it on the update channel, and repeating it here would
                       // be the bandwidth the per-URI gate exists to avoid.
                       assert.ok(
                          !reported.includes(model.uri),
                          `onDocumentsBuilt named the WATCHED ${model.uri}; it is reported on the update channel instead`
                       );
                    } finally {
                       driver.dispose();
                    }
                 }
               : undefined
      });

      const breakingEdit = language.breakingEdit;
      checks.push({
         title: `an edit that changes a watched dependent credits the dependent's event to no client ${tag}`,
         skipReason: !dependent
            ? cascadeSkipReason
            : breakingEdit === undefined
              ? 'fixture supplies no `breakingEdit` (a text for `valid` that changes what `dependent` shows)'
              : undefined,
         body:
            dependent && breakingEdit !== undefined
               ? async () => {
                    const driver = await connect();
                    try {
                       const model = resolveModel(valid);
                       const other = resolveModel(dependent);
                       const eventsFor = (uri: string, from = 0): TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>[] =>
                          driver.events.slice(from).filter(event => event.document.uri === uri);
                       await seed(driver, model);
                       // The dependent's seeder keeps it open: an open document is
                       // the one a head could wrongly credit to its opener.
                       await seed(driver, other);
                       // Watched after the seeds: a seed that changes nothing, over
                       // a fixture file that holds its text already, sends a watcher
                       // nothing to wait for.
                       await driver.proxy.watchModelDocument({ uri: model.uri, clientId: SUBSCRIBER });
                       await driver.proxy.watchModelDocument({ uri: other.uri, clientId: SUBSCRIBER });
                       const author = await openAs(driver, model.uri);
                       const before = driver.events.length;

                       const answer = await driver.proxy.updateModelDocument({
                          uri: model.uri,
                          clientId: author,
                          model: resolveDeferred(breakingEdit),
                          baseVersion: 'any'
                       });

                       const written = (): TransferDocumentUpdatedEvent<TTransfer, TDiagnostic> | undefined =>
                          eventsFor(model.uri, before).find(event => event.document.model?.version === answer.model?.version);
                       await waitFor(() => written() !== undefined && eventsFor(other.uri, before).length > 0, {
                          message: `no onDocumentUpdated event for both ${model.uri} and its dependent ${other.uri} after the breaking edit`
                       });
                       assert.deepStrictEqual(
                          { reason: written()?.reason, sourceClientId: written()?.sourceClientId },
                          { reason: 'changed', sourceClientId: author },
                          'the written document’s event is not the author’s change'
                       );
                       // A recipient drops an event naming its own id as its echo, so
                       // a dependent's event credited to the author, or to the client
                       // that has the dependent open, is lost to exactly the client
                       // that would show it.
                       for (const event of eventsFor(other.uri, before)) {
                          assert.deepStrictEqual(
                             { reason: event.reason, sourceClientId: event.sourceClientId },
                             { reason: 'rebuilt', sourceClientId: UNKNOWN_CLIENT_ID },
                             'the dependent’s event is not a rebuild that names no client'
                          );
                       }
                    } finally {
                       driver.dispose();
                    }
                 }
               : undefined
      });

      checks.push({
         title: `subscribe + update delivers an onDocumentUpdated event with the originating clientId ${tag}`,
         skipReason: edit ? undefined : editSkipReason,
         body: edit
            ? async () => {
                 const driver = await connect();
                 try {
                    const model = resolveModel(valid);
                    // The seeder's write comes BEFORE any subscription, under an id
                    // distinct from the author's so an event it caused is
                    // recognisable: a head that fans notifications out regardless
                    // of its subscription table is otherwise indistinguishable from
                    // one that honours the table, since both deliver something for
                    // the post-subscribe write.
                    const seeder = await seed(driver, model);
                    const author = await openAs(driver, model.uri);
                    await driver.proxy.watchModelDocument({ uri: model.uri, clientId: SUBSCRIBER });
                    await driver.proxy.updateModelDocument({
                       uri: model.uri,
                       clientId: author,
                       model: resolveDeferred(edit.to),
                       baseVersion: 'any'
                    });
                    await waitFor(() => driver.events.some(event => event.sourceClientId === author), {
                       message: `no onDocumentUpdated event for ${model.uri} after the post-subscription update`
                    });
                    const last = driver.events[driver.events.length - 1];
                    assert.strictEqual(last.document.uri, model.uri);
                    assert.strictEqual(last.sourceClientId, author);
                    // The first delivery of the author's version is a change;
                    // reported as rebuilt, it says the event echoes no write.
                    assert.strictEqual(last.reason, 'changed');
                    // Nothing from before the subscription. Waiting for the
                    // post-subscribe event first is what makes this provable: the
                    // two notifications share one ordered connection, so a seeding
                    // event that was ever going to arrive has arrived by now.
                    assert.ok(
                       !driver.events.some(event => event.sourceClientId === seeder),
                       'an onDocumentUpdated event arrived for the update made BEFORE watchModelDocument'
                    );
                 } finally {
                    driver.dispose();
                 }
              }
            : undefined
      });
   }

   return checks;
}
