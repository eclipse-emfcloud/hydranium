/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Logger } from '@hydranium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { LANGUAGE_CLIENT_ID } from '../../src/documents/client-ids.js';
import { SessionClosedError } from '../../src/documents/client-session-errors.js';
import type { ClientSessionClosedEvent } from '../../src/documents/client-session-registry.js';
import { HydraniumTextDocuments } from '../../src/documents/hydranium-text-documents.js';
import type { ServerSharedServices } from '../../src/langium/module.js';
import { DefaultDocumentUriPolicy } from '../../src/langium/workspace/document-uri-policy.js';
import { type CapturedLine, makeCapturingTracer } from '../../src/testing/index.js';

const A = 'file:///a.x';
const B = 'file:///b.x';

function makeDocs(): { docs: HydraniumTextDocuments<TextDocument>; lines: CapturedLine[] } {
   const { tracer, lines } = makeCapturingTracer();
   const services = {
      Tracer: { for: () => tracer },
      workspace: { DocumentUriPolicy: new DefaultDocumentUriPolicy() }
   } as unknown as ServerSharedServices;
   return { docs: new HydraniumTextDocuments(services), lines };
}

function open(docs: HydraniumTextDocuments<TextDocument>, uri: string, clientId: string, text = 'text'): void {
   docs.notifyDidOpenTextDocument({ textDocument: { uri, languageId: 'plaintext', version: 1, text } }, clientId);
}

/** Every `onDidClose`, as `clientId uri`, in delivery order. */
function recordCloses(docs: HydraniumTextDocuments<TextDocument>): string[] {
   const closes: string[] = [];
   docs.onDidClose(event => closes.push(`${event.clientId} ${event.document.uri}`));
   return closes;
}

afterEach(() => {
   Logger.setLevel('info');
});

describe('HydraniumTextDocuments — client sessions', () => {
   it('closes everything a session has open, then announces the session closed', () => {
      const { docs } = makeDocs();
      docs.registerSession('s');
      open(docs, A, 's');
      open(docs, B, 's');
      open(docs, A, 'other');
      const closes = recordCloses(docs);
      const sessionCloses: Array<{ event: ClientSessionClosedEvent; stillOpen: boolean }> = [];
      docs.onDidCloseSession(event => sessionCloses.push({ event, stillOpen: docs.isOpenInClient(A, 's') }));

      docs.closeSession('s');

      expect(closes).toEqual([`s ${A}`, `s ${B}`]);
      expect(sessionCloses).toEqual([{ event: { clientId: 's' }, stillOpen: false }]);
      expect(docs.isOpenInClient(A, 'other')).toBe(true);
      expect(docs.isOpen(B)).toBe(false);
   });

   it('refuses an open that a close listener issues for the session being closed', () => {
      const { docs } = makeDocs();
      docs.registerSession('s');
      open(docs, A, 's');
      const reopenErrors: unknown[] = [];
      docs.onDidClose(event => {
         if (event.clientId === 's') {
            try {
               open(docs, B, 's');
            } catch (err: unknown) {
               reopenErrors.push(err);
            }
         }
      });

      docs.closeSession('s');

      expect(reopenErrors).toHaveLength(1);
      expect(reopenErrors[0]).toBeInstanceOf(SessionClosedError);
      expect(docs.isOpen(B)).toBe(false);
   });

   it('logs a session id shortened to its label and eight characters, and the full id at trace', () => {
      Logger.setLevel('trace');
      const { docs, lines } = makeDocs();
      const id = 'form#0123456789abcdef';

      docs.registerSession(id);

      const messages = lines.map(line => `${line.level} ${line.message}`);
      expect(messages).toContainEqual(expect.stringMatching(/^info .*form#01234567(?!8)/));
      expect(messages.filter(message => message.startsWith('info')).join('\n')).not.toContain(id);
      expect(messages).toContainEqual(expect.stringMatching(new RegExp(`^trace .*${id}`)));
   });
});

describe('HydraniumTextDocuments — deletion closes opens', () => {
   it('closes every open of a URI when a subclass deletes it, and continues its version sequence', () => {
      const { docs } = makeDocs();
      open(docs, A, 'form');
      open(docs, A, LANGUAGE_CLIENT_ID);
      docs.applyContentChange(A, 'edited', 'form');
      const version = docs.version(A);
      const closes = recordCloses(docs);

      docs.delete(A);

      expect(closes).toEqual([`form ${A}`, `${LANGUAGE_CLIENT_ID} ${A}`]);
      expect(docs.isOpenInAnyClient(A)).toBe(false);
      expect(docs.openDocuments()).toEqual([]);
      expect(docs.version(A)).toBe(version);
   });

   it('closes the opens of a deleted file but leaves the editor its own', () => {
      const { docs } = makeDocs();
      docs.registerSession('s');
      open(docs, A, 's');
      open(docs, A, 'legacy');
      open(docs, A, LANGUAGE_CLIENT_ID);
      const closes = recordCloses(docs);

      docs.notifyDocumentDeleted(A);

      expect(closes).toEqual([`s ${A}`, `legacy ${A}`]);
      expect(docs.openDocuments()).toEqual([{ uri: A, clients: [LANGUAGE_CLIENT_ID] }]);
   });

   it('drops a deleted file no editor holds', () => {
      const { docs } = makeDocs();
      open(docs, A, 'form');

      docs.notifyDocumentDeleted(A);

      expect(docs.isOpen(A)).toBe(false);
   });
});
