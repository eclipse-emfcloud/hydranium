/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it, vi } from 'vitest';
import { type AstNode, DocumentState, URI } from '@hydranium/langium';
import { CancellationToken } from 'vscode-languageserver';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { DuplicateClientIdError } from '../../../src/documents/client-session-errors.js';
import { type SessionEndCause } from '../../../src/documents/client-session-registry.js';
import { type ModelUpdatedEvent } from '../../../src/langium/model-service/model-events.js';
import { type AstDiagnostic } from '../../../src/langium/validation/document-validator.js';
import { makeFakeAstNode, makeFakeDocument, makeTestServices } from '../../../src/testing/index.js';

interface FakeRoot extends AstNode {
   readonly $type: 'FakeRoot';
   readonly name: string;
}

const URI_A = 'file:///a.x';
const URI_B = 'file:///b.x';

const diagnostic: AstDiagnostic = {
   message: 'm',
   severity: DiagnosticSeverity.Error,
   range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
} as AstDiagnostic;

function documentAt(uri: string, diagnostics: AstDiagnostic[] = []) {
   return makeFakeDocument<FakeRoot>(uri, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'n' }), { diagnostics });
}

function harness() {
   const bundle = makeTestServices<FakeRoot>();
   return { ...bundle, models: bundle.modelService };
}

describe('ModelService onModelUpdated', () => {
   it('serves every subscriber of a phase from one builder listener, with one shared event', () => {
      const { models, documentBuilder } = harness();
      const registered = vi.spyOn(documentBuilder, 'onDocumentPhase');
      const seen: Array<ModelUpdatedEvent<FakeRoot>> = [];

      models.onModelUpdated(event => seen.push(event), { uri: URI_A });
      models.onModelUpdated(event => seen.push(event));
      documentBuilder.firePhase(DocumentState.Validated, documentAt(URI_A));

      expect(registered).toHaveBeenCalledTimes(1);
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBe(seen[1]);
      expect(seen[0].phase).toBe(DocumentState.Validated);
   });

   it('hears only its own URI when filtered, and every URI when not', () => {
      const { models, documentBuilder } = harness();
      const filtered: string[] = [];
      const all: string[] = [];

      models.onModelUpdated(event => filtered.push(event.document.uri), { uri: URI_A });
      models.onModelUpdated(event => all.push(event.document.uri));
      documentBuilder.firePhase(DocumentState.Validated, documentAt(URI_A));
      documentBuilder.firePhase(DocumentState.Validated, documentAt(URI_B));

      expect(filtered).toEqual([URI_A]);
      expect(all).toEqual([URI_A, URI_B]);
   });

   it('copies the diagnostics at Validated, so a later build appending to the live array leaves the event alone', () => {
      const { models, documentBuilder } = harness();
      const document = documentAt(URI_A, [diagnostic]);
      const seen: Array<ModelUpdatedEvent<FakeRoot>> = [];
      models.onModelUpdated(event => seen.push(event));

      documentBuilder.firePhase(DocumentState.Validated, document);
      document.diagnostics?.push(diagnostic);

      expect(seen[0].document.diagnostics).toHaveLength(1);
   });

   it('carries no diagnostics below Validated', () => {
      const { models, documentBuilder } = harness();
      const seen: Array<ModelUpdatedEvent<FakeRoot>> = [];
      models.onModelUpdated(event => seen.push(event), { phase: DocumentState.IndexedReferences });

      documentBuilder.firePhase(DocumentState.IndexedReferences, documentAt(URI_A, [diagnostic]));

      expect(seen).toHaveLength(1);
      expect(seen[0].document.diagnostics).toBeUndefined();
      expect(seen[0].phase).toBe(DocumentState.IndexedReferences);
   });

   it('still delivers to the other subscribers when one throws', () => {
      const { models, documentBuilder } = harness();
      const seen: string[] = [];
      models.onModelUpdated(() => {
         throw new Error('boom');
      });
      models.onModelUpdated(event => seen.push(event.document.uri));

      documentBuilder.firePhase(DocumentState.Validated, documentAt(URI_A));

      expect(seen).toEqual([URI_A]);
   });

   it('delivers nothing for a cancelled build, and nothing after the subscription is disposed', () => {
      const { models, documentBuilder } = harness();
      const seen: string[] = [];
      const subscription = models.onModelUpdated(event => seen.push(event.document.uri));

      documentBuilder.firePhase(DocumentState.Validated, documentAt(URI_A), CancellationToken.Cancelled);
      documentBuilder.firePhase(DocumentState.Validated, documentAt(URI_A));
      subscription.dispose();
      documentBuilder.firePhase(DocumentState.Validated, documentAt(URI_A));

      expect(seen).toEqual([URI_A]);
   });
});

describe('ModelService workspace events', () => {
   it('onModelsBuilt reports one build at its phase, and skips a cancelled one', () => {
      const { models, documentBuilder } = harness();
      const builds: string[][] = [];
      models.onModelsBuilt(event => builds.push([...event.uris]));

      documentBuilder.fireBuildPhase(DocumentState.Validated, [documentAt(URI_A), documentAt(URI_B)]);
      documentBuilder.fireBuildPhase(DocumentState.Validated, [documentAt(URI_A)], CancellationToken.Cancelled);

      expect(builds).toEqual([[URI_A, URI_B]]);
   });

   it('onModelsBuilt still reaches the other listeners when one throws', () => {
      const { models, documentBuilder } = harness();
      const builds: string[][] = [];
      models.onModelsBuilt(() => {
         throw new Error('boom');
      });
      models.onModelsBuilt(event => builds.push([...event.uris]));

      documentBuilder.fireBuildPhase(DocumentState.Validated, [documentAt(URI_A)]);

      expect(builds).toEqual([[URI_A]]);
   });

   it('onModelDeleted reports each deleted URI the filter admits', () => {
      const { models, documentBuilder } = harness();
      const filtered: string[] = [];
      const all: string[] = [];
      models.onModelDeleted(event => filtered.push(event.uri), { uri: URI_B });
      models.onModelDeleted(event => all.push(event.uri));

      documentBuilder.fireOnUpdate([URI.parse(URI_A)], [URI.parse(URI_A), URI.parse(URI_B)]);

      expect(filtered).toEqual([URI_B]);
      expect(all).toEqual([URI_A, URI_B]);
   });

   it('onDirtyChanged and onModelReleased filter by URI', () => {
      const { models, textDocuments } = harness();
      textDocuments.seedOpen(URI_A, 'a', 'c1');
      textDocuments.seedOpen(URI_B, 'b', 'c1');
      const dirty: string[] = [];
      const released: string[] = [];
      models.onDirtyChanged(event => dirty.push(event.uri), { uri: URI_A });
      models.onModelReleased(event => released.push(event.uri), { uri: URI_B });

      textDocuments.applyContentChange(URI_A, 'a2', 'c1');
      textDocuments.applyContentChange(URI_B, 'b2', 'c1');
      textDocuments.fireClose(URI_A, 'c1');
      textDocuments.fireClose(URI_B, 'c1');

      // Dirty on the edit, clean again on the release.
      expect(dirty).toEqual([URI_A, URI_A]);
      expect(released).toEqual([URI_B]);
   });
});

describe('ModelService session takeover', () => {
   it('ends the live session as lost when the resume token matches, and tells its holder', () => {
      const { models } = harness();
      const first = models.createSession('test', 'client', { resumeToken: 'token' });
      const causes: SessionEndCause[] = [];
      first.onDidDispose(cause => causes.push(cause));

      const second = models.createSession('test', 'client', { resumeToken: 'token' });

      expect(causes).toEqual(['lost']);
      expect(models.getSession('client')).toBe(second);
   });

   it('refuses the id without a matching token', () => {
      const { models } = harness();
      models.createSession('test', 'client', { resumeToken: 'token' });
      models.createSession('test', 'other');

      expect(() => models.createSession('test', 'client', { resumeToken: 'wrong' })).toThrow(DuplicateClientIdError);
      expect(() => models.createSession('test', 'client')).toThrow(DuplicateClientIdError);
      expect(() => models.createSession('test', 'other', { resumeToken: 'token' })).toThrow(DuplicateClientIdError);
   });

   it('forgets a token once its session ended, so it takes over nothing started after', () => {
      const { models } = harness();
      models.createSession('test', 'client', { resumeToken: 'token' }).dispose();
      const later = models.createSession('test', 'client');

      expect(() => models.createSession('test', 'client', { resumeToken: 'token' })).toThrow(DuplicateClientIdError);
      expect(models.getSession('client')).toBe(later);
   });

   it('reports the cause the store ended a session with', () => {
      const { models, textDocuments } = harness();
      const session = models.createSession('test', 'client');
      const causes: SessionEndCause[] = [];
      session.onDidDispose(cause => causes.push(cause));

      textDocuments.closeSession('client', 'lost');

      expect(causes).toEqual(['lost']);
   });

   it('reports the cause a session was disposed with, once', () => {
      const { models } = harness();
      const session = models.createSession('test', 'client');
      const causes: SessionEndCause[] = [];
      session.onDidDispose(cause => causes.push(cause));

      session.dispose();
      session.dispose('lost');

      expect(causes).toEqual(['closed']);
   });
});
