/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Composition test for the close→rebuild→arm→shed chain that reclaims a closed
 * document's CST. The residency unit tests drive the build-phase pass directly;
 * this file wires the REAL pieces the production chain runs through:
 *
 *  1. `HydraniumTextDocuments` — real per-URI multi-client ref-counting
 *     (`notifyDidOpen/CloseTextDocument`), and the revert it dispatches for a
 *     `file:` document once its last client closed it.
 *  2. `CstResidencyService` — its `Validated` build-phase pass arms the idle
 *     timer for the closed document included in that rebuild.
 *
 * The only simulated seam is the DocumentBuilder itself: when the store
 * dispatches, the test runs the captured build-phase pass with the document —
 * the documented contract of a build reaching `Validated` with the closed
 * document in the batch. Everything upstream of that seam (ref counting,
 * last-client gating, arming, idle expiry, bail-on-reopen) is real.
 *
 * This mirrors the multi-client pattern of two editors sharing one URI: the
 * document must shed only after EVERY client closed, and a close with no
 * subsequent user activity must still shed — closing is itself the trigger,
 * not an incidental later build.
 */

import { describe, expect, it } from 'vitest';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { type LangiumDocument, URI } from '@hydranium/langium';
import { Disposable } from '@hydranium/protocol';
import { makeFakeClock, tick, waitFor } from '@hydranium/protocol/testing';
import { LANGUAGE_CLIENT_ID } from '../../../src/documents/client-ids.js';
import { HydraniumTextDocuments } from '../../../src/documents/hydranium-text-documents.js';
import type { ServerSharedServices } from '../../../src/langium/module.js';
import { DefaultCstResidencyService } from '../../../src/langium/residency/cst-residency-service.js';
import { DefaultDocumentUriPolicy } from '../../../src/langium/workspace/document-uri-policy.js';
import { makeNoopSharedServices } from '../../../src/testing/index.js';
import { DefaultModelLedger } from '../../../src/documents/model-ledger.js';
import { DefaultVersionSyncService } from '../../../src/documents/version-sync-service.js';

const DOC_URI = 'file:///a.x';
const IDLE_MS = 1000;

/** A build-phase pass captured at registration time so the test can drive its `run`. */
interface CapturedPass {
   run(documents: readonly LangiumDocument[]): void;
}

interface Composition {
   docs: HydraniumTextDocuments<TextDocument>;
   /** URIs of each rebuild the store dispatched (close-triggered). */
   dispatches: string[][];
   pass: CapturedPass;
   clock: ReturnType<typeof makeFakeClock>;
   document: LangiumDocument;
   open(clientId: string): void;
   close(clientId: string): void;
}

function makeComposition(): Composition {
   const clock = makeFakeClock();
   const langiumDocs = new Map<string, LangiumDocument>();
   let capturedPass: CapturedPass | undefined;
   const dispatches: string[][] = [];

   const noop = (): void => undefined;
   const services = makeNoopSharedServices<ServerSharedServices>({
      Clock: clock,
      workspace: {
         LangiumDocuments: { getDocument: (uri: URI) => langiumDocs.get(uri.toString()) },
         DocumentBuilder: {
            update: (changed: URI[]) => {
               dispatches.push(changed.map(uri => uri.toString()));
               return Promise.resolve();
            },
            resetToState: noop,
            markNextReason: noop
         },
         WorkspaceLock: {
            write: (callback: (token: unknown) => unknown) => callback(undefined),
            read: async (callback: () => unknown) => callback()
         },
         ModelLedger: new DefaultModelLedger(),
         WorkspaceManager: { ready: Promise.resolve(), workspaceInitialized: Promise.resolve() },
         SelfSaveRegistry: { isRegistered: () => false },
         FileSystemProvider: { exists: async () => true },
         DocumentUriPolicy: new DefaultDocumentUriPolicy(),
         FileSystemTaskQueue: { enqueue: (_uri: string, task: () => Promise<unknown>) => task() },
         BuildPhasePassService: {
            register: (pass: CapturedPass) => {
               capturedPass = pass;
               return Disposable.EMPTY;
            }
         }
      }
   });

   services.workspace.VersionSyncService = new DefaultVersionSyncService(services);
   const docs = new HydraniumTextDocuments<TextDocument>(services);
   // The store is itself a workspace service — close the self-reference so the
   // residency service reads the SAME real instance.
   Object.assign(services.workspace, { TextDocuments: docs });

   new DefaultCstResidencyService(services, { strategy: { kind: 'shed-closed-when-idle', idleMs: IDLE_MS } });
   if (!capturedPass) {
      throw new Error('CstResidencyService did not register a build-phase pass');
   }

   const document = makeDocument(DOC_URI);
   langiumDocs.set(document.uri.toString(), document);

   return {
      docs,
      dispatches,
      pass: capturedPass,
      clock,
      document,
      open: clientId =>
         docs.notifyDidOpenTextDocument({ textDocument: { uri: DOC_URI, languageId: 'plaintext', version: 1, text: 'x' } }, clientId),
      close: clientId => docs.notifyDidCloseTextDocument({ textDocument: { uri: DOC_URI } }, clientId)
   };
}

/** A two-node AST document with CST attached to every node (same shape as the residency unit tests). */
function makeDocument(uriText: string): LangiumDocument {
   const child: Record<string, unknown> = { $type: 'Child', $cstNode: {} };
   const root: Record<string, unknown> = { $type: 'Root', $cstNode: {}, child };
   child.$container = root;
   return {
      uri: URI.parse(uriText),
      parseResult: { value: root },
      references: []
   } as unknown as LangiumDocument;
}

function cstNodeCount(document: LangiumDocument): number {
   const root = document.parseResult.value as { $cstNode?: unknown; child?: { $cstNode?: unknown } };
   return (root.$cstNode ? 1 : 0) + (root.child?.$cstNode ? 1 : 0);
}

describe('CST shed on close — real ref-counting through the real close trigger', () => {
   it('a document open in two clients sheds only after the LAST client closes', async () => {
      const { dispatches, pass, clock, document, open, close } = makeComposition();

      // Multi-client shape: two clients attach to the same URI.
      open('form-editor');
      open(LANGUAGE_CLIENT_ID);

      // A build while the document is open never arms the shed timer.
      pass.run([document]);
      clock.advance(IDLE_MS * 100);
      expect(cstNodeCount(document)).toBe(2);

      // Partial close: the other client still holds the URI — the store
      // dispatches no rebuild, so nothing can arm the timer.
      close('form-editor');
      await tick();
      expect(dispatches).toEqual([]);
      clock.advance(IDLE_MS * 100);
      expect(cstNodeCount(document)).toBe(2);

      // Last close: the store dispatches the rebuild for exactly this URI.
      close(LANGUAGE_CLIENT_ID);
      await waitFor(() => dispatches.length > 0);
      expect(dispatches).toEqual([[DOC_URI]]);

      // The triggered rebuild reaches Validated with the (now closed) document
      // in the batch — the residency pass arms the idle timer.
      pass.run([document]);
      clock.advance(IDLE_MS - 1);
      expect(cstNodeCount(document)).toBe(2); // idle window not yet elapsed
      clock.advance(1);
      expect(cstNodeCount(document)).toBe(0); // shed — close alone reclaimed it
   });

   it('reopening during the idle window keeps the document resident', () => {
      const { pass, clock, document, open, close } = makeComposition();

      open(LANGUAGE_CLIENT_ID);
      pass.run([document]);
      close(LANGUAGE_CLIENT_ID);
      pass.run([document]); // close-triggered rebuild arms the timer

      // User reopens the file before the idle window elapses; the reopen's
      // build re-runs the pass, which cancels the pending shed.
      open(LANGUAGE_CLIENT_ID);
      pass.run([document]);
      clock.advance(IDLE_MS * 100);
      expect(cstNodeCount(document)).toBe(2);
   });
});
