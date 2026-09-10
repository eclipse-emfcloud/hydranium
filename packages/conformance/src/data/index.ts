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
 * {@link DataServerProtocol} proxy (plus the captured `onDocumentUpdated`
 * events), so no upstream wire-lib dep enters the kit and `DataServerHarness`
 * satisfies the port structurally with no adapter.
 */

import assert from 'node:assert/strict';
import { ReferenceSource, SyntheticStep, TransferDocument, type TransferDiagnostic, type TransferElement } from '@hydranium/protocol';
import type { DataServerProtocol, ReferenceServerProtocol, TransferDocumentUpdatedEvent } from '@hydranium/protocol/data';
import { type Harness, waitFor } from '@hydranium/protocol/testing';
import type { ConformanceCheck } from '../conformance-suite.js';
import { type LanguageFixture, resolveDeferred, resolveModel } from '../model.js';

/**
 * The data-server driver port — a live, connected, READY data-server exposed
 * through its protocol-native proxy plus the captured client-side update
 * events. The kit names only `@hydranium/protocol` types, so a
 * `DataServerHarness` satisfies the port structurally (it has `proxy` +
 * `events` + `dispose`) with NO adapter. `extends Harness` gives the kit the
 * universal `dispose()` teardown.
 *
 * The kit seeds documents purely through the proxy: `updateModelDocument` is
 * an upsert (it creates a cold URI from the payload, not just modifies an
 * existing one), so the slice needs no services-level open hook. The adopter
 * only has to stand the server up READY in its `connect` — see
 * {@link DataConformanceOptions.connect}.
 */
export interface DataConformanceDriver<
   TTransfer extends TransferElement,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic
> extends Harness {
   readonly proxy: DataServerProtocol<TTransfer, TDiagnostic>;
   /** Captured `onDocumentUpdated` events, append order — the subscription check's observation target. */
   readonly events: ReadonlyArray<TransferDocumentUpdatedEvent<TTransfer, TDiagnostic>>;
   /**
    * The opt-in reference surface, when the head serves it.
    *
    * Separate from {@link proxy} because `ReferenceServerProtocol` is NOT part
    * of `DataServerProtocol` — a head may serve documents and no references at
    * all. Absent means the reference check reports skipped with a named reason
    * rather than failing a head that never claimed the surface.
    */
   readonly references?: ReferenceServerProtocol<TTransfer>;
}

/** Options for `runDataConformance`. */
export interface DataConformanceOptions<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic = TransferDiagnostic> {
   /**
    * Establish a freshly-wired, connected, READY data-server driver. Called
    * once per check for isolation; the kit disposes it after the check. The
    * adopter must initialise the workspace before returning, so `waitForReady`
    * resolves rather than hanging.
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
   /** Suite title override. Default `'conformance: data-server'`. */
   readonly suiteTitle?: string;
}

/** Client id the kit seeds/edits documents under (the originating author). */
const AUTHOR = 'conformance-author';
/** Client id the kit subscribes under — distinct from {@link AUTHOR} so the echo is recognisable. */
const SUBSCRIBER = 'conformance-subscriber';
/**
 * Client id for a write made BEFORE any subscription exists. Distinct from
 * {@link AUTHOR} so an event caused by it is recognisable: a head that fans
 * notifications out regardless of its subscription table is otherwise
 * indistinguishable from one that honours the table, since both deliver
 * something for the post-subscribe write.
 */
const SEEDER = 'conformance-seeder';

/**
 * Build the data-server check battery: server-level checks once, then the
 * grammar-bearing checks per language. Each check connects a fresh driver
 * and disposes it, so checks never interfere. Exported for the kit's own
 * unit tests; adopters call `runDataConformance`.
 *
 * `LanguageFixture.edit` is read HERE and nowhere else in the kit, and is
 * optional: its two checks report skipped when it is absent. See
 * {@link LanguageFixture} for which slice reads which field.
 */
export function buildDataChecks<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic = TransferDiagnostic>(
   options: DataConformanceOptions<TTransfer, TDiagnostic>
): ConformanceCheck[] {
   const { connect, expectsProjects } = options;
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
      const { valid, invalid, edit } = language;
      const tag = `[${valid.languageId}]`;

      checks.push({
         title: `getModelDocument(valid) returns a coherent envelope ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               // Resolved AFTER `connect`, which is the whole point of allowing a
               // thunk: the fixture may name a workspace `connect` just created.
               const model = resolveModel(valid);
               await driver.proxy.updateModelDocument({ uri: model.uri, clientId: AUTHOR, model: model.text });
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
               const { root } = TransferDocument.assertLoaded(document);
               assert.ok(
                  typeof root.$type === 'string' && root.$type.length > 0,
                  `getModelDocument(valid) returned a root with no $type: ${JSON.stringify(root)}`
               );
               // `version` is the conflict token every later update gates on, so
               // an envelope that omits it is unusable however good the root is.
               assert.ok(
                  Number.isInteger(document.version),
                  `getModelDocument(valid) returned a non-integer version: ${String(document.version)}`
               );
               assert.deepStrictEqual(document.diagnostics, []);
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
               await driver.proxy.updateModelDocument({ uri: model.uri, clientId: AUTHOR, model: model.text });
               // Diagnostics are a validation-phase product; a synchronous read settles at the
               // integrity-settled phase by default, so request validation explicitly here.
               // Safe despite `includeDiagnostics` waiting rather than forcing a build: the
               // update above has already driven this document through validation.
               const document = await driver.proxy.getModelDocument({ uri: model.uri, includeDiagnostics: true });
               assert.ok(document.diagnostics.length >= 1, 'getModelDocument(invalid) reported no diagnostics');
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
               await driver.proxy.updateModelDocument({ uri: model.uri, clientId: AUTHOR, model: model.text });
               const document = await driver.proxy.getModelDocument({ uri: model.uri, includeDiagnostics: true });

               // Conditional rather than fixture-driven, and deliberately so: what
               // an `invalid` fixture provokes is the adopter's choice, and a
               // syntactic error legitimately carries no identity at all. The
               // invariant is that the identity travels WHOLE or not — a `code`
               // without `params` is the half-state that renders a translated
               // template with its placeholders left standing, and it is
               // reachable only by overriding `toTransferDiagnostic`.
               const halfIdentities = document.diagnostics.filter(
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
                    await driver.proxy.updateModelDocument({ uri: model.uri, clientId: AUTHOR, model: model.text });

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

      // Opt-in: both remaining checks need a second, observably different model
      // text, which only `edit` supplies.
      const editSkipReason = 'fixture supplies no `edit` (data-slice only; omit it if this language is not driven through the data head)';

      checks.push({
         title: `updateModelDocument applies an edit a follow-up get reflects ${tag}`,
         skipReason: edit ? undefined : editSkipReason,
         body: edit
            ? async () => {
                 const driver = await connect();
                 try {
                    const model = resolveModel(valid);
                    await driver.proxy.updateModelDocument({ uri: model.uri, clientId: AUTHOR, model: model.text });
                    await driver.proxy.updateModelDocument({ uri: model.uri, clientId: AUTHOR, model: resolveDeferred(edit.to) });
                    const document = await driver.proxy.getModelDocument({ uri: model.uri });
                    assert.ok(edit.expect(document.root), 'edit.expect(root) was false — the edit was not reflected by a follow-up get');
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
                    await driver.proxy.updateModelDocument({ uri: model.uri, clientId: SEEDER, model: model.text });
                    await driver.proxy.watchModelDocument({ uri: model.uri, clientId: SUBSCRIBER });
                    await driver.proxy.updateModelDocument({ uri: model.uri, clientId: AUTHOR, model: resolveDeferred(edit.to) });
                    await waitFor(() => driver.events.some(event => event.sourceClientId === AUTHOR), {
                       message: `no onDocumentUpdated event for ${model.uri} after the post-subscription update`
                    });
                    const last = driver.events[driver.events.length - 1];
                    assert.strictEqual(last.document.uri, model.uri);
                    assert.strictEqual(last.sourceClientId, AUTHOR);
                    // Nothing from before the subscription. Waiting for the
                    // post-subscribe event first is what makes this provable: the
                    // two notifications share one ordered connection, so a seeding
                    // event that was ever going to arrive has arrived by now.
                    assert.ok(
                       !driver.events.some(event => event.sourceClientId === SEEDER),
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
