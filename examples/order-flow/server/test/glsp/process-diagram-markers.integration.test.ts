/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `HydraniumGlspModelValidator` bound on the `.process` diagram — LSP
 * diagnostics reaching the canvas as GLSP markers.
 *
 * # Why this suite is an integration suite
 *
 * `DiagramModule.bindModelValidator()` is GLSP's one OPTIONAL binding on this
 * path and `HydraniumGlspStorage` injects the slot `@optional()`, so an unbound
 * validator is not an error — it is a diagram that never shows a marker, with no
 * log line to say so. Nothing short of the assembled container can tell the two
 * apart.
 *
 * The framework's own unit suite covers the pure translation over fakes. What it
 * cannot reach is the case that dominates in practice: a diagram routinely
 * renders elements defined in OTHER documents. That needs a real multi-document
 * workspace, a real index carrying real reference projections, and real
 * diagnostics published on a document that is not the diagram's own — which is
 * what the cases below set up.
 *
 * # The trap this suite is written around
 *
 * After `initializeWorkspaceProgrammatically` the documents are **linked, not
 * validated** — the init build's landmark is `IntegrityService.SettledState` and
 * its options leave `validation` unset. So `document.diagnostics` is `undefined`
 * for every file and `markers()` returns `[]` for reasons that have nothing to do
 * with the binding under test. Every case therefore asserts the absence of
 * diagnostics BEFORE the validating build and their presence after it, so a
 * marker assertion can never pass on an empty diagnostic set.
 *
 * # Why the errors are LINKING errors
 *
 * A parser/lexer diagnostic carries no `element` path, and `diagnosticsToMarkers`
 * drops anything it cannot resolve to an AST node. Only a validator-produced
 * diagnostic — which for this workspace means an unresolvable cross-reference —
 * can become a marker at all.
 */

import 'reflect-metadata';
import { type Marker, MarkersReason, ModelValidator, ServerModule, SetMarkersAction } from '@eclipse-glsp/server';
import { HydraniumGlspAppModule, HydraniumGlspModelValidator } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { URI, type LangiumDocument } from '@hydranium/langium';
import { readFileSync } from 'node:fs';
import { Diagnostic } from 'vscode-languageserver';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { isTask } from '../../src/language-server/ast.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness, type OrderFlowHarness } from '../order-flow-harness.js';

const DIAGRAM_TYPE = 'order-flow-process';

/** The `.process` diagram open over a scratch workspace, plus what a case needs to drive it. */
interface OpenDiagram {
   readonly services: OrderFlowHarness;
   readonly harness: GlspHarness<OrderFlowGlspState>;
   readonly workspace: ScratchWorkspace;
}

let open: OpenDiagram | undefined;

/**
 * Replace `from` with `to` in a scratch workspace file, failing loudly when the
 * text is not there.
 *
 * The guard is the point: every case here depends on having introduced a real
 * linking error, and a silently-missed replacement would leave a clean workspace
 * — where "no markers" is the correct answer and the negative case passes for the
 * wrong reason.
 */
function breakReference(workspace: ScratchWorkspace, relativePath: string, from: string, to: string): void {
   const before = readFileSync(workspace.resolve(relativePath), 'utf8');
   if (!before.includes(from)) {
      throw new Error(`${relativePath} does not contain ${JSON.stringify(from)} — the sample workspace changed`);
   }
   workspace.write(relativePath, before.replace(from, to));
}

/**
 * Boot the real GLSP container over a scratch copy and open `fulfillment.process`.
 *
 * `prepare` authors the broken content BEFORE the workspace is initialized, so
 * the initial build links against it and the GModel factory's reference
 * projections are registered against the same AST the diagnostics are published
 * on. Editing after the open would be a rebuild scenario — a different subject.
 */
async function openDiagram(prepare?: (workspace: ScratchWorkspace) => void): Promise<OpenDiagram> {
   const { harness: services, workspace } = await makeScratchWorkspaceHarness(prepare);
   const harness = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: DIAGRAM_TYPE,
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })],
      // The framework storage pushes markers as a `SetMarkersAction`, and GLSP's
      // `ClientActionForwarder` only forwards kinds the session declared — an
      // undeclared kind never reaches the harness capture.
      additionalClientActionKinds: [SetMarkersAction.KIND]
   });
   await harness.start();
   await harness.openDocument(workspace.resolve(WORKSPACE_FILES.fulfillmentProcess));
   open = { services, harness, workspace };
   return open;
}

/** The loaded document for a workspace-relative path in the scratch copy. */
async function documentIn(diagram: OpenDiagram, relativePath: string): Promise<LangiumDocument> {
   const uri = URI.file(diagram.workspace.resolve(relativePath));
   return diagram.services.shared.workspace.LangiumDocuments.getOrCreateDocument(uri);
}

/**
 * Build `relativePath` to `Validated` and return its diagnostics.
 *
 * The whole reason this helper exists is the header's trap: without it the
 * diagnostics are `undefined` and every marker assertion below would be
 * measuring an empty input.
 */
async function validateDocument(diagram: OpenDiagram, relativePath: string): Promise<Diagnostic[]> {
   const document = await documentIn(diagram, relativePath);
   await diagram.services.shared.workspace.DocumentBuilder.build([document], { validation: true });
   return document.diagnostics ?? [];
}

/** The markers the bound validator reports for the whole diagram. */
async function currentMarkers(diagram: OpenDiagram): Promise<Marker[]> {
   const validator = diagram.harness.sessionContainer.get<ModelValidator>(ModelValidator);
   return await validator.validate([diagram.harness.state.root], MarkersReason.BATCH);
}

/**
 * The GModel id of a task's effect label — the element an effect is drawn as,
 * and the id both the own-document and the projected case must land on.
 *
 * Read through the live index rather than composed here: an unnamed `Effect` is
 * keyed `` `<task>.effects@<index>` `` by `NameBasedKeyProvider`'s fallback, and
 * a hand-written id would drift from that silently.
 */
function effectLabelId(diagram: OpenDiagram, taskName: string): string {
   const task = diagram.harness.state.sourceRoot.nodes.filter(isTask).find(node => node.name === taskName);
   if (!task) {
      throw new Error(`no task named ${taskName}`);
   }
   const [effect] = task.effects;
   if (!effect) {
      throw new Error(`task ${taskName} has no effect`);
   }
   return diagram.harness.state.index.createId(effect);
}

/** Messages of every marker on `elementId`. */
function markersOn(markers: Marker[], elementId: string): string[] {
   return markers.filter(marker => marker.elementId === elementId).map(marker => marker.label);
}

/**
 * A diagnostic's message as plain text. LSP 3.18 allows a `MarkupContent`
 * message and GLSP markers are plain text, so the marker mapping normalises
 * through `Diagnostic.getMessageString` — comparing against the raw field would
 * be comparing a marker label to a possibly-structured value.
 */
function messageOf(diagnostic: Diagnostic): string {
   return Diagnostic.getMessageString(diagnostic);
}

/**
 * The markers the server pushed to the client since `since`, flattened.
 *
 * Polled rather than awaited on a single action, for two reasons measured here:
 * the storage's `refreshDiagnosticMarkers` runs on a floating promise off the
 * build's phase notification, so it settles after `build()` resolves; and a
 * `SetMarkersAction` also arrives for CLEAN rebuilds, so waiting for "the next
 * one" can consume an empty push. Recording the length before acting and then
 * reading the tail is the discipline any such fan-out needs — a diagnostic
 * fan-out on the LSP side wants exactly the same treatment.
 */
async function waitForPushedMarkers(diagram: OpenDiagram, since: number, timeoutMs = 2000): Promise<Marker[]> {
   const deadline = Date.now() + timeoutMs;
   while (Date.now() < deadline) {
      const markers = diagram.harness.actions
         .slice(since)
         .filter(SetMarkersAction.is)
         .flatMap(action => action.markers);
      if (markers.length > 0) {
         return markers;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
   }
   const kinds = diagram.harness.actions.slice(since).map(action => action.kind);
   throw new Error(`no non-empty SetMarkersAction within ${timeoutMs}ms — captured since: ${kinds.join(', ') || '(nothing)'}`);
}

describe('order-flow .process diagram markers', () => {
   afterEach(() => {
      open?.harness.dispose();
      open?.workspace.dispose();
      open = undefined;
   });

   it('binds the framework validator on the diagram-module slot GLSP leaves optional', async () => {
      const diagram = await openDiagram();

      // The composition half. Left unbound, `HydraniumGlspStorage` resolves
      // `undefined` for its `@optional()` slot and `refreshDiagnosticMarkers`
      // returns early — no error, no log line, no markers ever.
      expect(diagram.harness.sessionContainer.get(ModelValidator)).toBeInstanceOf(HydraniumGlspModelValidator);
   });

   it('marks an element of the diagram own document', async () => {
      const diagram = await openDiagram(workspace =>
         breakReference(workspace, WORKSPACE_FILES.fulfillmentProcess, 'reads Order.id', 'reads Order.noSuchField')
      );
      const pickEffect = effectLabelId(diagram, 'Pick');
      // Drawn, so a marker on it is something a user can actually see.
      expect(diagram.harness.state.index.find(pickEffect)).toBeDefined();
      expect((await documentIn(diagram, WORKSPACE_FILES.fulfillmentProcess)).diagnostics ?? []).toEqual([]);

      const diagnostics = await validateDocument(diagram, WORKSPACE_FILES.fulfillmentProcess);

      expect(diagnostics).toHaveLength(1);
      expect(messageOf(diagnostics[0])).toContain('noSuchField');
      expect(markersOn(await currentMarkers(diagram), pickEffect)).toEqual([messageOf(diagnostics[0])]);
   });

   it('pushes those markers to the client after a rebuild, without being asked', async () => {
      const diagram = await openDiagram(workspace =>
         breakReference(workspace, WORKSPACE_FILES.fulfillmentProcess, 'reads Order.id', 'reads Order.noSuchField')
      );

      // The live-refresh half: the framework storage recomputes markers on every
      // rebuild that reaches `Validated` and pushes them itself, so the canvas
      // follows a text edit instead of waiting for the palette validate command.
      const before = diagram.harness.actions.length;
      await validateDocument(diagram, WORKSPACE_FILES.fulfillmentProcess);
      const pushed = await waitForPushedMarkers(diagram, before);

      expect(markersOn(pushed, effectLabelId(diagram, 'Pick'))).toHaveLength(1);
   });

   it('marks a projected element of ANOTHER document, and drops one this diagram does not draw', async () => {
      // `Order.id` is drawn — `task Pick reads Order.id` projects the field onto
      // its effect label. `LineItem.price` is not drawn at all: no effect in
      // `fulfillment.process` touches it, and `LineItem` has no node of its own.
      // Both errors are published on `orders.domain`, never on the `.process`
      // file, so reaching either one at all is the `renderedDocumentUris()` scan.
      const diagram = await openDiagram(workspace => {
         breakReference(workspace, WORKSPACE_FILES.ordersDomain, 'id: ID', 'id: NoSuchIdType');
         breakReference(workspace, WORKSPACE_FILES.ordersDomain, 'price: Money', 'price: NoSuchPriceType');
      });
      const domainUri = URI.file(diagram.workspace.resolve(WORKSPACE_FILES.ordersDomain)).toString();

      // The projection registered, so the validator will scan the other document.
      // Without this the scan skips it and both cases below would report nothing
      // — the negative would pass for the wrong reason.
      expect(diagram.harness.state.index.renderedDocumentUris()).toContain(domainUri);

      const messages = (await validateDocument(diagram, WORKSPACE_FILES.ordersDomain)).map(messageOf);
      expect(messages.filter(message => message.includes('NoSuchIdType'))).toHaveLength(1);
      expect(messages.filter(message => message.includes('NoSuchPriceType'))).toHaveLength(1);

      const markers = await currentMarkers(diagram);

      // The positive: the error on `Order.id`'s type reference walks up to the
      // field, which the effect label is registered as rendering.
      expect(markersOn(markers, effectLabelId(diagram, 'Pick'))).toEqual(messages.filter(message => message.includes('NoSuchIdType')));
      // The negative: nothing on the `LineItem.price` chain is drawn here, so
      // the `isRendered` filter drops it. The text editor still reports it.
      expect(markers.map(marker => marker.label).join('\n')).not.toContain('NoSuchPriceType');
   });
});
