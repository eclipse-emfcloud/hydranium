/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type ApplyWorkspaceEditResult, CancellationToken, Range, type WorkspaceEdit } from 'vscode-languageserver';
import { TextDocument as TextDocumentImpl } from 'vscode-languageserver-textdocument';
import type { TextDocument, TextDocumentContentChangeEvent } from 'vscode-languageserver-textdocument';
import type { ServerSharedServices } from '../../src/langium/module.js';
import { LANGUAGE_CLIENT_ID } from '../../src/documents/client-ids.js';
import { HydraniumTextDocuments } from '../../src/documents/hydranium-text-documents.js';
import { DefaultDocumentUriPolicy } from '../../src/langium/workspace/document-uri-policy.js';

const URI = 'file:///a.x';

interface RecordedApplyEdit {
   // Production `applyEditToLanguageClient` passes a bare `WorkspaceEdit`
   // (`{ label, documentChanges: [...] }`) to `connection.workspace.applyEdit`,
   // not an `ApplyWorkspaceEditParams` wrapper — so `documentChanges` is read here.
   params: WorkspaceEdit;
}

interface ConnectionStub {
   workspace: {
      applyEdit: (params: WorkspaceEdit) => Promise<ApplyWorkspaceEditResult>;
   };
}

interface LogCall {
   uri: string;
   message: string;
}

interface LoggerStub {
   warnCalls: LogCall[];
   infoCalls: LogCall[];
   debugCalls: LogCall[];
   trace: () => LoggerStub;
   with: (uri: string) => Record<string, (msg: string) => void>;
}

function makeLogger(): LoggerStub {
   const warnCalls: LogCall[] = [];
   const infoCalls: LogCall[] = [];
   const debugCalls: LogCall[] = [];
   const noop = (): void => undefined;
   const stub: LoggerStub = {
      warnCalls,
      infoCalls,
      debugCalls,
      trace: () => stub,
      with: (uri: string) => ({
         warn: (message: string) => warnCalls.push({ uri, message }),
         info: (message: string) => infoCalls.push({ uri, message }),
         debug: (message: string) => debugCalls.push({ uri, message }),
         error: noop,
         trace: noop,
         // refreshContent (triggered when a second client attaches to an
         // already-open URI) routes through startTimerForUri.
         startTimer: () => ({ dispose: noop })
      })
   };
   return stub;
}

function makeSharedServices(connection: ConnectionStub | undefined, logger?: LoggerStub): ServerSharedServices {
   return {
      lsp: connection ? { Connection: connection } : undefined,
      Logger: { for: () => logger },
      // The stub's `with(uri)` surface carries startTimer/warn, so it doubles as the Tracer.
      Tracer: { for: () => logger },
      workspace: {
         // Minimum stubs required by notifyDidClose / notifyDidOpen reaching into the workspace tree.
         LangiumDocuments: { getDocument: () => undefined },
         DocumentBuilder: { update: () => undefined, resetToState: () => undefined },
         WorkspaceManager: { workspaceInitialized: Promise.resolve() },
         // The store always resolves keys through the canonicalizer; the framework
         // default (syntactic normalize) is what production binds absent a stronger identity.
         DocumentUriPolicy: new DefaultDocumentUriPolicy()
      }
   } as unknown as ServerSharedServices;
}

function makeDocs(connection: ConnectionStub | undefined = undefined): {
   docs: HydraniumTextDocuments<TextDocument>;
   recorded: RecordedApplyEdit[];
   logger: LoggerStub;
} {
   const recorded: RecordedApplyEdit[] = [];
   const wrappedConnection: ConnectionStub | undefined = connection && {
      workspace: {
         applyEdit: async params => {
            recorded.push({ params });
            return connection.workspace.applyEdit(params);
         }
      }
   };
   const logger = makeLogger();
   const services = makeSharedServices(wrappedConnection, logger);
   // The framework's tracer surface is `with(uri).warn(msg)`; the LoggerStub
   // matches it and is returned from both `services.Logger.for(...)` and
   // `services.Tracer.for(...)` — the latter is what the constructor resolves.
   const docs = new HydraniumTextDocuments(services);
   return { docs, recorded, logger };
}

/** Drive a `didOpen` directly so the shadow gets baselined like Monaco opening a file. */
function openInLanguageClient(docs: HydraniumTextDocuments<TextDocument>, text: string): void {
   docs.notifyDidOpenTextDocument({ textDocument: { uri: URI, languageId: 'plaintext', version: 1, text } }, LANGUAGE_CLIENT_ID);
}

describe('HydraniumTextDocuments.applyEditToLanguageClient', () => {
   it('returns undefined when no Connection is bound', async () => {
      const { docs } = makeDocs(undefined);
      const result = await docs.applyEditToLanguageClient(URI, 'anything');
      expect(result).toBeUndefined();
   });

   it('sends a full-document replace when the shadow has no baseline', async () => {
      const { docs, recorded } = makeDocs({
         workspace: { applyEdit: async () => ({ applied: true }) }
      });
      const result = await docs.applyEditToLanguageClient(URI, 'hello\nworld\n');
      expect(result).toEqual({ applied: true });
      expect(recorded).toHaveLength(1);
      const edits = (recorded[0].params.documentChanges![0] as { edits: Array<{ newText: string }> }).edits;
      expect(edits).toHaveLength(1);
      expect(edits[0].newText).toBe('hello\nworld\n');
   });

   it('sends a minimal diff when the shadow has a baseline', async () => {
      const { docs, recorded } = makeDocs({
         workspace: { applyEdit: async () => ({ applied: true }) }
      });
      openInLanguageClient(docs, 'a\nb\nc\n');
      await docs.applyEditToLanguageClient(URI, 'a\nB\nc\n');
      const edits = (recorded[0].params.documentChanges![0] as { edits: Array<{ newText: string }> }).edits;
      // Diff hits only the middle line; the framework should not emit a full replace.
      expect(edits.length).toBeGreaterThan(0);
      expect(edits[edits.length - 1].newText).not.toBe('a\nB\nc\n');
   });

   it('returns undefined and skips the RPC when shadow already matches newText', async () => {
      const { docs, recorded } = makeDocs({
         workspace: { applyEdit: async () => ({ applied: true }) }
      });
      openInLanguageClient(docs, 'identical\n');
      const result = await docs.applyEditToLanguageClient(URI, 'identical\n');
      expect(result).toBeUndefined();
      expect(recorded).toHaveLength(0);
   });

   it('invalidates the shadow when applyEdit reports applied=false', async () => {
      const { docs, recorded } = makeDocs({
         workspace: { applyEdit: async () => ({ applied: false }) }
      });
      openInLanguageClient(docs, 'a\nb\n');
      await docs.applyEditToLanguageClient(URI, 'a\nB\n');
      // The shadow was invalidated, so the next push cannot diff against it and
      // must send one full-range replace rather than a line-keyed edit.
      await docs.applyEditToLanguageClient(URI, 'totally\nnew\n');
      const edits = (recorded[1].params.documentChanges![0] as { edits: Array<{ newText: string }> }).edits;
      expect(edits).toHaveLength(1);
      expect(edits[0].newText).toBe('totally\nnew\n');
   });

   it('invalidates the shadow when applyEdit RPC throws and re-raises', async () => {
      const { docs } = makeDocs({
         workspace: {
            applyEdit: async () => {
               throw new Error('connection lost');
            }
         }
      });
      openInLanguageClient(docs, 'a\nb\n');
      await expect(docs.applyEditToLanguageClient(URI, 'a\nB\n')).rejects.toThrow(/connection lost/);
      // Shadow is invalidated → next call returns a full replace, not a diff.
      const { docs: docs2, recorded } = makeDocs({
         workspace: { applyEdit: async () => ({ applied: true }) }
      });
      openInLanguageClient(docs2, 'a\nb\n');
      docs2.invalidateLanguageClientText(URI);
      await docs2.applyEditToLanguageClient(URI, 'a\nB\n');
      const edits = (recorded[0].params.documentChanges![0] as { edits: Array<{ newText: string }> }).edits;
      expect(edits).toHaveLength(1);
      expect(edits[0].newText).toBe('a\nB\n');
   });
});

describe('HydraniumTextDocuments shadow auto-tracking', () => {
   it('language-client didOpen baselines the shadow', async () => {
      const { docs, recorded } = makeDocs({
         workspace: { applyEdit: async () => ({ applied: true }) }
      });
      openInLanguageClient(docs, 'opened\n');
      // Same text → no RPC because shadow already matches.
      const r1 = await docs.applyEditToLanguageClient(URI, 'opened\n');
      expect(r1).toBeUndefined();
      expect(recorded).toHaveLength(0);
   });

   it('language-client didChange updates the shadow', async () => {
      const { docs, recorded } = makeDocs({
         workspace: { applyEdit: async () => ({ applied: true }) }
      });
      openInLanguageClient(docs, 'v1\n');
      docs.notifyDidChangeTextDocument(
         {
            textDocument: { uri: URI, version: 2 },
            contentChanges: [{ text: 'v2\n' }]
         },
         LANGUAGE_CLIENT_ID
      );
      // Shadow is now v2; applyEditToLanguageClient with v2 → no RPC.
      await docs.applyEditToLanguageClient(URI, 'v2\n');
      expect(recorded).toHaveLength(0);
   });

   it('non-language-client didChange does NOT touch the shadow', async () => {
      const { docs, recorded } = makeDocs({
         workspace: { applyEdit: async () => ({ applied: true }) }
      });
      openInLanguageClient(docs, 'baseline\n');
      docs.notifyDidChangeTextDocument(
         {
            textDocument: { uri: URI, version: 2 },
            contentChanges: [{ text: 'form-edited\n' }]
         },
         'form-editor'
      );
      // Shadow is still 'baseline\n'; outbound applyEditToLanguageClient should produce a diff.
      await docs.applyEditToLanguageClient(URI, 'form-edited\n');
      expect(recorded).toHaveLength(1);
      const edits = (recorded[0].params.documentChanges![0] as { edits: Array<{ newText: string }> }).edits;
      // Replaces baseline → form-edited (single-line diff or full replace; either way edits is non-empty).
      expect(edits.length).toBeGreaterThan(0);
   });

   it('language-client didClose invalidates the shadow', async () => {
      const { docs, recorded } = makeDocs({
         workspace: { applyEdit: async () => ({ applied: true }) }
      });
      openInLanguageClient(docs, 'alive\n');
      docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, LANGUAGE_CLIENT_ID);
      // Post-close, next applyEditToLanguageClient sends a full replace.
      await docs.applyEditToLanguageClient(URI, 'alive\n');
      expect(recorded).toHaveLength(1);
      const edits = (recorded[0].params.documentChanges![0] as { edits: Array<{ newText: string }> }).edits;
      expect(edits).toHaveLength(1);
      expect(edits[0].newText).toBe('alive\n');
   });
});

/**
 * The push channel to the LSP textual language client ships LINE-KEYED edits,
 * which only land correctly on the exact text they were diffed against. The
 * shadow's apply-verify checks the diff against that believed text, so it cannot
 * see the client's real buffer moving underneath an in-flight push.
 *
 * These pin the version gate that makes the difference. The failure they stand
 * against is not a wrong diagnostic — it is a spliced source file: the edit's
 * ranges address shifted lines, so half a declaration survives next to its
 * replacement. In a real workspace the integrity tier then "repairs" the
 * resulting duplicate name into a suffixed one and persists it, which is how the
 * corruption reaches disk looking like a naming bug.
 *
 * A stub client with a REAL buffer is what makes that observable: a stub that
 * answers `{applied: true}` without applying anything cannot show a splice.
 */
describe('HydraniumTextDocuments.applyEditToLanguageClient version gate', () => {
   it('addresses a line-keyed diff at the version the language client last declared', async () => {
      const { docs, recorded } = makeDocs({
         workspace: { applyEdit: async () => ({ applied: true }) }
      });
      openInLanguageClient(docs, 'a\nb\nc\n');
      docs.notifyDidChangeTextDocument(
         { textDocument: { uri: URI, version: 7 }, contentChanges: [{ text: 'a\nb\nc2\n' }] },
         LANGUAGE_CLIENT_ID
      );
      await docs.applyEditToLanguageClient(URI, 'a\nB\nc2\n');
      const identifier = (recorded[0].params.documentChanges![0] as { textDocument: { version: number | null } }).textDocument;
      expect(identifier.version).toBe(7);
   });

   it('leaves a full replace unversioned, since it lands correctly on any buffer', async () => {
      const { docs, recorded } = makeDocs({
         workspace: { applyEdit: async () => ({ applied: true }) }
      });
      // Opened, so a client version exists — but with the shadow invalidated the
      // push is a full replace, which must NOT carry that version: gating it would
      // refuse the one edit shape that is always safe to apply.
      openInLanguageClient(docs, 'a\nb\n');
      docs.invalidateLanguageClientText(URI);
      await docs.applyEditToLanguageClient(URI, 'a\nB\n');
      const identifier = (recorded[0].params.documentChanges![0] as { textDocument: { version: number | null } }).textDocument;
      expect(identifier.version).toBeNull();
   });

   it('sends no version for a document the language client never opened', async () => {
      const { docs, recorded } = makeDocs({
         workspace: { applyEdit: async () => ({ applied: true }) }
      });
      await docs.applyEditToLanguageClient(URI, 'fresh\n');
      const identifier = (recorded[0].params.documentChanges![0] as { textDocument: { version: number | null } }).textDocument;
      expect(identifier.version).toBeNull();
   });

   it('a version-checking client rejects a diff its buffer has outrun, instead of splicing it', async () => {
      const ORIGINAL = ['SharedType BaseType {', '   TypeOne Element ref ns.Element', '   TypeTwo Missing ref ns.Missing', '}', ''].join(
         '\n'
      );
      // What a properties-panel field write serialises back: same model, reformatted.
      const SETTLED = [
         'SharedType BaseType {',
         '   TypeOne Element',
         '      ref ns.Element',
         '   TypeTwo Missing',
         '      ref ns.Missing',
         '}',
         ''
      ].join('\n');
      // The user typed one line into the editor while the push was in flight.
      const USER_EDITED = '// a note\n' + ORIGINAL;

      // A client that honours the version gate the way VS Code does: it applies an
      // edit addressed at `null` (unknown) unconditionally, and one addressed at a
      // version its buffer has moved past not at all.
      let clientText = ORIGINAL;
      let clientVersion = 1;
      // Bound after `docs` exists — the stub client has to talk back to the store
      // to deliver the keystroke's didChange from inside the in-flight window.
      let onApplyEdit: (params: WorkspaceEdit) => ApplyWorkspaceEditResult = () => ({ applied: true });
      const { docs } = makeDocs({ workspace: { applyEdit: async params => onApplyEdit(params) } });
      onApplyEdit = params => {
         // The in-flight window: the keystroke lands in the editor buffer and its
         // didChange reaches the server before the edit is applied.
         clientText = USER_EDITED;
         clientVersion = 2;
         docs.notifyDidChangeTextDocument(
            { textDocument: { uri: URI, version: clientVersion }, contentChanges: [{ text: USER_EDITED }] },
            LANGUAGE_CLIENT_ID
         );
         const change = params.documentChanges![0] as {
            textDocument: { version: number | null };
            edits: Array<{ range: unknown; newText: string }>;
         };
         if (change.textDocument.version !== null && change.textDocument.version !== clientVersion) {
            return { applied: false };
         }
         clientText = TextDocumentImpl.applyEdits(
            TextDocumentImpl.create(URI, 'plaintext', 0, clientText),
            change.edits as Parameters<typeof TextDocumentImpl.applyEdits>[1]
         );
         return { applied: true };
      };

      openInLanguageClient(docs, ORIGINAL);
      const result = await docs.applyEditToLanguageClient(URI, SETTLED);

      expect(result).toEqual({ applied: false });
      // Whole-text equality, not a count of one marker: the splice this stands
      // against also drops the header line and half a member, so counting one
      // marker would pass on a differently-shaped corruption.
      expect(clientText).toBe(USER_EDITED);
   });
});

describe('HydraniumTextDocuments.isOpenInAnyClient', () => {
   /**
    * `isOpenInAnyClient` reads the per-URI tracking record's `clients` set
    * (updated synchronously BEFORE the close event fires), so subscribers to {@link onDidClose}
    * can use it to detect the last-close transition. The downstream
    * "rebuild from disk for `file:` URIs / drop from index for ephemeral
    * URIs" decision lives in `HydraniumDocumentUpdateHandler.didCloseDocument`,
    * not in this manager.
    */
   it('returns false before any open', () => {
      const { docs } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      expect(docs.isOpenInAnyClient(URI)).toBe(false);
   });

   it('returns true while the language client holds the document', () => {
      const { docs } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      openInLanguageClient(docs, 'alive\n');
      expect(docs.isOpenInAnyClient(URI)).toBe(true);
   });

   it('returns true at onDidClose fire time when other clients still hold the URI', () => {
      const { docs } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      openInLanguageClient(docs, 'alive\n');
      // Attach a second client to the same URI.
      docs.notifyDidOpenTextDocument({ textDocument: { uri: URI, languageId: 'plaintext', version: 1, text: 'alive\n' } }, 'glsp-client');
      let observedDuringFire: boolean | undefined;
      docs.onDidClose(() => {
         observedDuringFire = docs.isOpenInAnyClient(URI);
      });
      // First client closes — second client still holds it.
      docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, LANGUAGE_CLIENT_ID);
      expect(observedDuringFire).toBe(true);
   });

   it('returns false at onDidClose fire time when the last client closes', () => {
      const { docs } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      openInLanguageClient(docs, 'alive\n');
      let observedDuringFire: boolean | undefined;
      docs.onDidClose(() => {
         observedDuringFire = docs.isOpenInAnyClient(URI);
      });
      docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, LANGUAGE_CLIENT_ID);
      expect(observedDuringFire).toBe(false);
   });
});

describe('HydraniumTextDocuments.openDocuments', () => {
   it('is empty before any open', () => {
      const { docs } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      expect(docs.openDocuments()).toEqual([]);
   });

   it('lists a document with every client id holding it', () => {
      const { docs } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      openInLanguageClient(docs, 'alive\n');
      docs.notifyDidOpenTextDocument({ textDocument: { uri: URI, languageId: 'plaintext', version: 1, text: 'alive\n' } }, 'form-editor');
      const open = docs.openDocuments();
      expect(open).toHaveLength(1);
      expect(open[0].uri).toBe(URI);
      expect(open[0].clients).toEqual(expect.arrayContaining([LANGUAGE_CLIENT_ID, 'form-editor']));
      expect(open[0].clients).toHaveLength(2);
   });

   it('drops the client on a partial close and the document on the last close', () => {
      const { docs } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      openInLanguageClient(docs, 'alive\n');
      docs.notifyDidOpenTextDocument({ textDocument: { uri: URI, languageId: 'plaintext', version: 1, text: 'alive\n' } }, 'form-editor');

      docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, 'form-editor');
      expect(docs.openDocuments()).toEqual([{ uri: URI, clients: [LANGUAGE_CLIENT_ID] }]);

      docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, LANGUAGE_CLIENT_ID);
      // A lingering entry here is the signature of a client that failed to close —
      // the diagnostic this accessor exists to surface via the server-state snapshot.
      expect(docs.openDocuments()).toEqual([]);
   });
});

describe('HydraniumTextDocuments version gate and close reset', () => {
   it('drops a late change whose version is not newer than the synced document', () => {
      const { docs } = makeDocs();
      // Open at v1, then accept monotonic edits up to v3.
      openInLanguageClient(docs, 'v1\n');
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'v2\n' }] }, LANGUAGE_CLIENT_ID);
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 3 }, contentChanges: [{ text: 'v3\n' }] }, LANGUAGE_CLIENT_ID);
      // A late edit arrives at v2 from a different client — older than current v3.
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'late\n' }] }, 'form-editor');
      // The version gate ignored it: version stays at the highest accepted...
      expect(docs.version(URI)).toBe(3);
      // ...the synced text is the last accepted, not the late one...
      expect(docs.get(URI)?.getText()).toBe('v3\n');
      // ...and the late client did NOT overwrite the original author of v2.
      expect(docs.getAuthor(URI, 2)).toBe(LANGUAGE_CLIENT_ID);
   });

   it('keeps document state when one of two clients closes', () => {
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'shared\n');
      // A second client attaches to the same URI.
      docs.notifyDidOpenTextDocument({ textDocument: { uri: URI, languageId: 'plaintext', version: 1, text: 'shared\n' } }, 'glsp-client');
      docs.notifyDidChangeTextDocument(
         { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'edited\n' }] },
         LANGUAGE_CLIENT_ID
      );
      // Close only the language client; the glsp client still holds the URI.
      docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, LANGUAGE_CLIENT_ID);
      expect(docs.isOpen(URI)).toBe(true);
      expect(docs.version(URI)).toBe(2);
      expect(docs.getAuthor(URI)).toBe(LANGUAGE_CLIENT_ID);
      expect(docs.get(URI)?.getText()).toBe('edited\n');
   });

   it('clears client state on last close while the version sequence survives', () => {
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'first\n');
      // Unbaselined author, accepted via the shared-version fallback; content
      // changed → server assigns v2 (the client-declared 5 is NOT adopted).
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 5 }, contentChanges: [{ text: 'evolved\n' }] }, 'glsp-client');
      expect(docs.version(URI)).toBe(2);
      // Stage pending content before the close to prove it does not survive.
      docs.stagePendingContent(URI, 'staged-before-close\n');
      // Close the only client.
      docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, LANGUAGE_CLIENT_ID);
      expect(docs.isOpen(URI)).toBe(false);
      // Re-open with DIFFERENT content: the sequence steps past the pre-close
      // version — it never restarts at the client-declared open version.
      openInLanguageClient(docs, 'reopened\n');
      expect(docs.version(URI)).toBe(3);
      // Author history does NOT survive the close (only the sequence does)...
      expect(docs.getAuthor(URI, 2)).toBeUndefined();
      // ...the reopened doc reflects only the new open, not the staged-before-close text.
      expect(docs.get(URI)?.getText()).toBe('reopened\n');
      expect(docs.getAuthor(URI, 3)).toBe(LANGUAGE_CLIENT_ID);
   });
});

describe('HydraniumTextDocuments author history and pending content', () => {
   it('records authors at the server-assigned version, not the client-declared one', () => {
      const { docs, logger } = makeDocs();
      // Open at v1 authored by 'A'.
      docs.notifyDidOpenTextDocument({ textDocument: { uri: URI, languageId: 'plaintext', version: 1, text: 'a\n' } }, 'A');
      // 'B' declares version 3 (its own client-side numbering). The change is
      // accepted, but the SHARED sequence steps to 2 — client numbers never
      // leak into the server-owned sequence.
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 3 }, contentChanges: [{ text: 'b\n' }] }, 'B');
      expect(docs.version(URI)).toBe(2);
      expect(docs.getAuthor(URI, 1)).toBe('A');
      expect(docs.getAuthor(URI, 2)).toBe('B');
      expect(docs.getAuthor(URI, 3)).toBeUndefined();
      // Latest author via `.at(-1)`.
      expect(docs.getAuthor(URI)).toBe('B');
      expect(logger.warnCalls).toHaveLength(0);
   });

   it('consumes staged pending content on open and does not re-apply it on a later open', () => {
      const { docs } = makeDocs();
      // Stage content for a URI that is not open yet.
      docs.stagePendingContent(URI, 'staged\n');
      // Open with stale disk text — staged content wins.
      docs.notifyDidOpenTextDocument(
         { textDocument: { uri: URI, languageId: 'plaintext', version: 1, text: 'stale-disk\n' } },
         LANGUAGE_CLIENT_ID
      );
      expect(docs.get(URI)?.getText()).toBe('staged\n');
      // Close the only client; pending was already consumed on the first open.
      docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, LANGUAGE_CLIENT_ID);
      // Re-open with disk text — no staged content is re-applied.
      docs.notifyDidOpenTextDocument(
         { textDocument: { uri: URI, languageId: 'plaintext', version: 1, text: 'disk-again\n' } },
         LANGUAGE_CLIENT_ID
      );
      expect(docs.get(URI)?.getText()).toBe('disk-again\n');
   });
});

describe('HydraniumTextDocuments notifyDidChangeTextDocument guards', () => {
   it('ignores a change event carrying an empty contentChanges array', () => {
      // Kills the `changes.length === 0` early-return guard: with the
      // guard removed the manager would proceed to bump the version with no
      // actual edits.
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'v1\n');
      const fires: number[] = [];
      docs.onDidChangeContent(() => fires.push(1));
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 2 }, contentChanges: [] }, LANGUAGE_CLIENT_ID);
      expect(docs.version(URI)).toBe(1);
      expect(docs.get(URI)?.getText()).toBe('v1\n');
      expect(fires).toHaveLength(0);
   });

   it('throws when a change event omits a version identifier', () => {
      // Kills the `version === null || version === undefined` throw guard:
      // the manager must reject a change with no valid version.
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'v1\n');
      expect(() =>
         docs.notifyDidChangeTextDocument(
            { textDocument: { uri: URI, version: undefined }, contentChanges: [{ text: 'x\n' }] } as never,
            LANGUAGE_CLIENT_ID
         )
      ).toThrow(/without valid version identifier/);
   });

   it('throws when a change event carries a null version', () => {
      // Kills the first disjunct of that same throw guard (`version === null` →
      // `false`): LSP allows a `null` version on the wire ("intentionally
      // unknown"). The `false || version === undefined` mutant would accept a
      // null version (null === undefined is false) and proceed instead of
      // throwing. The original throws because `null === null`.
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'v1\n');
      expect(() =>
         docs.notifyDidChangeTextDocument(
            { textDocument: { uri: URI, version: null }, contentChanges: [{ text: 'x\n' }] } as never,
            LANGUAGE_CLIENT_ID
         )
      ).toThrow(/without valid version identifier/);
   });

   it('does nothing for a change targeting a URI that is not synced', () => {
      // Kills the `document !== undefined` synced-document guard: with `if (true)` the
      // manager would dereference an undefined document and throw.
      const { docs } = makeDocs();
      expect(() =>
         docs.notifyDidChangeTextDocument(
            { textDocument: { uri: 'file:///x.other', version: 2 }, contentChanges: [{ text: 'x\n' }] },
            LANGUAGE_CLIENT_ID
         )
      ).not.toThrow();
      expect(docs.isOpen('file:///x.other')).toBe(false);
   });

   it('drops a change whose version equals the current synced version', () => {
      // Kills the staleness-guard boundary (`>=` → `>`): an equal-version echo
      // must be ignored, not re-applied.
      const { docs, logger } = makeDocs();
      openInLanguageClient(docs, 'v1\n');
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'v2\n' }] }, LANGUAGE_CLIENT_ID);
      // Now send another change at the SAME version 2 (an echo).
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'echo\n' }] }, 'form-editor');
      expect(docs.version(URI)).toBe(2);
      expect(docs.get(URI)?.getText()).toBe('v2\n');
      // Equal version → "already at version" reason (kills the reason branch + its strings).
      const reasons = logger.debugCalls.map(call => call.message);
      expect(reasons.some(message => /already at version 2/.test(message))).toBe(true);
   });

   it('skips the rebuild for a content-identical language-client echo', () => {
      // When the language client echoes text we already hold (e.g. Monaco
      // re-emitting a server-pushed applyEditToLanguageClient), the model is
      // unchanged, so the rebuild is redundant and must be skipped. The SHARED
      // version stays put (it advances iff content changes); only the
      // per-client baseline and the shadow track Monaco's new id.
      const { docs, logger } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      openInLanguageClient(docs, 'same\n');
      const fires: number[] = [];
      docs.onDidChangeContent(() => fires.push(1));
      docs.notifyDidChangeTextDocument(
         { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'same\n' }] },
         LANGUAGE_CLIENT_ID
      );
      // No rebuild fired...
      expect(fires).toHaveLength(0);
      // ...the shared version did NOT move (content is unchanged)...
      expect(docs.version(URI)).toBe(1);
      expect(docs.get(URI)?.getText()).toBe('same\n');
      // ...and the skip was logged at debug.
      expect(logger.debugCalls.some(call => /Skip rebuild: content unchanged/.test(call.message))).toBe(true);
   });

   it('still rebuilds for a content-identical change from a non-language client', () => {
      // The echo skip is restricted to the language client. A ModelService author
      // (form/GLSP/integrity) carrying identical text must NOT be skipped: those
      // writes are the ones whose server-side rebuild is correctness-bearing.
      // The shared version still does not move — content is unchanged.
      const { docs } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      openInLanguageClient(docs, 'same\n');
      const fires: string[] = [];
      docs.onDidChangeContent(event => fires.push(event.clientId));
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'same\n' }] }, 'form-editor');
      // Rebuild still fired for the non-language-client author.
      expect(fires).toEqual(['form-editor']);
      expect(docs.version(URI)).toBe(1);
   });

   it('distinguishes a strictly older incoming version in the ignore reason', () => {
      // A strictly older version from a BASELINED client must log the "older
      // than current" reason, not "already at" — the staleness compare runs
      // against the client's own last-seen id (3), not the shared version.
      const { docs, logger } = makeDocs();
      openInLanguageClient(docs, 'v1\n');
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 3 }, contentChanges: [{ text: 'v3\n' }] }, LANGUAGE_CLIENT_ID);
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'old\n' }] }, LANGUAGE_CLIENT_ID);
      const reasons = logger.debugCalls.map(call => call.message);
      expect(reasons.some(message => /older than current 3/.test(message))).toBe(true);
      expect(reasons.some(message => /already at version/.test(message))).toBe(false);
      // The stale packet did not clobber the accepted text.
      expect(docs.get(URI)?.getText()).toBe('v3\n');
   });
});

describe('HydraniumTextDocuments open / close client gating', () => {
   it('is idempotent: re-opening for the same client does not re-fire onDidOpen', () => {
      // Kills the `isOpenInClient` early-return guard in notifyDidOpen:
      // with `if (false)` a duplicate open for the same client would re-fire.
      const { docs } = makeDocs();
      const opens: number[] = [];
      docs.onDidOpen(() => opens.push(1));
      openInLanguageClient(docs, 'v1\n');
      openInLanguageClient(docs, 'v1\n');
      expect(opens).toHaveLength(1);
   });

   it('is idempotent: re-opening for the same client does not fire a change event', () => {
      // Kills that same `if (this.isOpenInClient(...))` early-return guard
      // (`if (false)`): the onDidOpen count alone does NOT distinguish the
      // mutant, because with the guard removed a same-client re-open falls
      // through to the `else` (attach) branch — which fires onDidChangeContent
      // via refreshContent but NOT onDidOpen. The original early-returns with
      // no event at all. Subscribe AFTER the first open and assert zero change
      // fires on the duplicate.
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'v1\n');
      const changeFires: number[] = [];
      docs.onDidChangeContent(() => changeFires.push(1));
      openInLanguageClient(docs, 'v1\n');
      expect(changeFires).toHaveLength(0);
   });

   it('does NOT baseline the shadow when a non-language client opens first', async () => {
      // Kills the `clientId === LANGUAGE_CLIENT_ID` guard in notifyDidOpen:
      // only the language client should baseline the Monaco shadow.
      const { docs, recorded } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      docs.notifyDidOpenTextDocument(
         { textDocument: { uri: URI, languageId: 'plaintext', version: 1, text: 'glsp-content\n' } },
         'glsp-client'
      );
      // Shadow was never set → outbound sync must be a full replace, not a no-op.
      const result = await docs.applyEditToLanguageClient(URI, 'glsp-content\n');
      expect(result).toEqual({ applied: true });
      expect(recorded).toHaveLength(1);
      const edits = (recorded[0].params.documentChanges![0] as { edits: Array<{ newText: string }> }).edits;
      expect(edits[0].newText).toBe('glsp-content\n');
   });

   it('does NOT invalidate the shadow when a non-language client closes', async () => {
      // Kills the `clientId === LANGUAGE_CLIENT_ID` guard in notifyDidClose:
      // a non-language client closing must leave the Monaco shadow intact.
      const { docs, recorded } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      openInLanguageClient(docs, 'shared\n');
      docs.notifyDidOpenTextDocument({ textDocument: { uri: URI, languageId: 'plaintext', version: 1, text: 'shared\n' } }, 'glsp-client');
      // glsp client closes; the language-client shadow ('shared\n') must survive.
      docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, 'glsp-client');
      // Shadow still matches → applyEditToLanguageClient with the same text is a quiet skip.
      const result = await docs.applyEditToLanguageClient(URI, 'shared\n');
      expect(result).toBeUndefined();
      expect(recorded).toHaveLength(0);
   });
});

describe('HydraniumTextDocuments applyEditToLanguageClient invalidation', () => {
   it('preserves the shadow when applyEdit reports applied=true', async () => {
      // Kills the `result.applied === false` mutations (`=== true`, `!== false`,
      // `if (true)`): an applied=true result must NOT invalidate the shadow.
      const { docs, recorded } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      openInLanguageClient(docs, 'a\nb\n');
      await docs.applyEditToLanguageClient(URI, 'a\nB\n');
      // Shadow now holds 'a\nB\n'. A second edit must diff against it (single line),
      // not fall back to a full replace (which is what invalidation would force).
      await docs.applyEditToLanguageClient(URI, 'a\nC\n');
      const edits = (recorded[1].params.documentChanges![0] as { edits: Array<{ newText: string }> }).edits;
      expect(edits[edits.length - 1].newText).not.toBe('a\nC\n');
   });
});

describe('HydraniumTextDocuments query helpers', () => {
   it('version() returns 0 for a URI that was never opened', () => {
      // Kills the `this.get(uri)?.version` optional-chaining mutation in version():
      // without `?.` an unopened URI would throw instead of returning 0.
      const { docs } = makeDocs();
      expect(docs.version('file:///x.other')).toBe(0);
   });

   it('isOpenInLanguageClient reflects only the language client', () => {
      // The only coverage of isOpenInLanguageClient.
      const { docs } = makeDocs();
      docs.notifyDidOpenTextDocument({ textDocument: { uri: URI, languageId: 'plaintext', version: 1, text: 'x\n' } }, 'glsp-client');
      expect(docs.isOpenInLanguageClient(URI)).toBe(false);
      openInLanguageClient(docs, 'x\n');
      expect(docs.isOpenInLanguageClient(URI)).toBe(true);
   });

   it('isOnlyOpenInClient is true for a single client and false once a second attaches', () => {
      // Covers/kills isOnlyOpenInClient: both the `size === 1` and the
      // `isOpenInClient` conjuncts must hold.
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'x\n');
      expect(docs.isOnlyOpenInClient(URI, LANGUAGE_CLIENT_ID)).toBe(true);
      // A different client is not the sole holder.
      expect(docs.isOnlyOpenInClient(URI, 'glsp-client')).toBe(false);
      // Two clients open → not "only" for either.
      docs.notifyDidOpenTextDocument({ textDocument: { uri: URI, languageId: 'plaintext', version: 1, text: 'x\n' } }, 'glsp-client');
      expect(docs.isOnlyOpenInClient(URI, LANGUAGE_CLIENT_ID)).toBe(false);
   });

   it('setLanguageClientText baselines the shadow without a didOpen', async () => {
      // The only coverage of setLanguageClientText.
      const { docs, recorded } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      docs.setLanguageClientText(URI, 'seeded\n');
      const result = await docs.applyEditToLanguageClient(URI, 'seeded\n');
      expect(result).toBeUndefined();
      expect(recorded).toHaveLength(0);
   });
});

describe('HydraniumTextDocuments getAuthor missing-version logging', () => {
   it('logs "Could not detect author" only when history exists but the version is absent', () => {
      // Kills getAuthor's `!clientId && history` guard and its message:
      // a present version must NOT log; a missing version (with history) must.
      const { docs, logger } = makeDocs();
      openInLanguageClient(docs, 'v1\n');
      // Present version: no "could not detect" log.
      expect(docs.getAuthor(URI, 1)).toBe(LANGUAGE_CLIENT_ID);
      expect(logger.infoCalls.some(call => /Could not detect author/.test(call.message))).toBe(false);
      // Missing version with existing history: logs once.
      expect(docs.getAuthor(URI, 7)).toBeUndefined();
      expect(logger.infoCalls.filter(call => /Could not detect author of version 7/.test(call.message))).toHaveLength(1);
   });
});

describe('HydraniumTextDocuments willSave notifications', () => {
   it('notifyWillSaveTextDocument fires onWillSave for a synced document', () => {
      // Covers notifyWillSaveTextDocument and its syncedDocument guard.
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'x\n');
      const onWillSave = (docs as unknown as { __onWillSave: { event: (cb: (event: { reason: number }) => void) => void } }).__onWillSave;
      const reasons: number[] = [];
      onWillSave.event(event => reasons.push(event.reason));
      docs.notifyWillSaveTextDocument({ textDocument: { uri: URI }, reason: 1 });
      expect(reasons).toEqual([1]);
   });

   it('notifyWillSaveTextDocumentWaitUntil returns [] when no waitUntil handler is registered', () => {
      // Covers notifyWillSaveTextDocumentWaitUntil's else-branch.
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'x\n');
      const result = docs.notifyWillSaveTextDocumentWaitUntil({ textDocument: { uri: URI }, reason: 1 }, CancellationToken.None);
      expect(result).toEqual([]);
   });

   it('notifyWillSaveTextDocument is a clean no-op for a URI that is not open', () => {
      // Kills notifyWillSaveTextDocument's `if (syncedDocument !== undefined)`
      // guard (`if (true)`): forced true, the manager would fire onWillSave for an
      // undefined synced document. The not-open case must NOT fire at all.
      const { docs } = makeDocs();
      const onWillSave = (docs as unknown as { __onWillSave: { event: (cb: (event: { reason: number }) => void) => void } }).__onWillSave;
      const reasons: number[] = [];
      onWillSave.event(event => reasons.push(event.reason));
      // URI was never opened → syncedDocument is undefined.
      expect(() => docs.notifyWillSaveTextDocument({ textDocument: { uri: 'file:///x.other' }, reason: 1 })).not.toThrow();
      expect(reasons).toHaveLength(0);
   });

   it('notifyDidSaveTextDocument is a clean no-op for a URI that is not open', () => {
      // Kills notifyDidSaveTextDocument's `if (syncedDocument !== undefined)`
      // guard (`if (true)`): forced true, the manager dereferences `syncedDocument.uri`
      // on an undefined document (throws) and fires onDidSave spuriously. The
      // not-open case must be a quiet no-op.
      const { docs } = makeDocs();
      const saves: string[] = [];
      docs.onDidSave(event => saves.push(event.document.uri));
      expect(() => docs.notifyDidSaveTextDocument({ textDocument: { uri: 'file:///x.other' } }, LANGUAGE_CLIENT_ID)).not.toThrow();
      expect(saves).toHaveLength(0);
   });

   it('notifyDidSaveTextDocument fires onDidSave for a synced document', () => {
      // Pins the positive direction of that same guard so both branches are
      // covered: an open document MUST fire onDidSave (kills `if (false)`).
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'x\n');
      const saves: string[] = [];
      docs.onDidSave(event => saves.push(event.document.uri));
      docs.notifyDidSaveTextDocument({ textDocument: { uri: URI } }, LANGUAGE_CLIENT_ID);
      expect(saves).toEqual([URI]);
   });

   it('notifyWillSaveTextDocumentWaitUntil ignores a registered handler when the URI is not open', () => {
      // Kills two mutants of notifyWillSaveTextDocumentWaitUntil's condition:
      // the EqualityOperator (`syncedDocument !== undefined`
      // → `=== undefined`) and the LogicalOperator (`&&` → `||`). A waitUntil
      // handler IS registered, but the URI is NOT open → syncedDocument is
      // undefined, so the original returns [] without invoking the handler.
      //   - `=== undefined`: undefined === undefined is true → would invoke handler.
      //   - `||`: false || handler(truthy) → would invoke handler.
      const { docs } = makeDocs();
      let invoked = 0;
      const handler = (): [] => {
         invoked++;
         return [];
      };
      (docs as unknown as { _willSaveWaitUntil: () => [] })._willSaveWaitUntil = handler;
      const result = docs.notifyWillSaveTextDocumentWaitUntil(
         { textDocument: { uri: 'file:///x.other' }, reason: 1 },
         CancellationToken.None
      );
      expect(result).toEqual([]);
      expect(invoked).toBe(0);
   });

   it('notifyWillSaveTextDocumentWaitUntil runs the registered handler for an open document', () => {
      // Pins the positive direction of that conjunction (synced AND handler):
      // an open document with a registered handler MUST invoke it, distinguishing
      // it from both the [] else-branch and a `if (true)` short-circuit.
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'x\n');
      const seen: string[] = [];
      const handler = (event: { document: { uri: string } }): never[] => {
         seen.push(event.document.uri);
         return [];
      };
      (docs as unknown as { _willSaveWaitUntil: typeof handler })._willSaveWaitUntil = handler;
      const result = docs.notifyWillSaveTextDocumentWaitUntil({ textDocument: { uri: URI }, reason: 1 }, CancellationToken.None);
      expect(result).toEqual([]);
      expect(seen).toEqual([URI]);
   });
});

describe('HydraniumTextDocuments second-client attach', () => {
   it('fires onDidChangeContent for the attaching client with the unchanged version', () => {
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'shared\n');
      // Subscribe AFTER the first open so we only observe the attach fire.
      const fires: Array<{ clientId: string; version: number }> = [];
      docs.onDidChangeContent(event => fires.push({ clientId: event.clientId, version: event.document.version }));
      // A second client attaches to the already-open URI.
      docs.notifyDidOpenTextDocument({ textDocument: { uri: URI, languageId: 'plaintext', version: 1, text: 'shared\n' } }, 'glsp-client');
      // refreshContent re-fires change for the attaching client without bumping the version.
      expect(fires).toEqual([{ clientId: 'glsp-client', version: 1 }]);
      // No new version was assigned, and the attach left the original author intact.
      expect(docs.version(URI)).toBe(1);
      expect(docs.getAuthor(URI, 1)).toBe(LANGUAGE_CLIENT_ID);
   });
});

describe('HydraniumTextDocuments server-owned version sequence', () => {
   // The shared document version is a server-owned, per-URI, monotonic counter
   // that advances exactly when the synced content changes — and never resets
   // while the server lives. Client-declared version ids (Monaco's model
   // versions) only feed the per-client staleness guard; they never leak into
   // the shared sequence. This is what makes a `baseVersion` optimistic gate
   // sound: version unchanged ⇔ content unchanged.

   it('accepts a language-client edit whose version id lags the shared sequence', () => {
      // The lost-keystroke case a spliced sequence can drop: an authored
      // (ModelService) write advances the shared sequence past Monaco's ids;
      // Monaco's NEXT real edit then arrives with a version id that is behind
      // the shared version but ahead of Monaco's own last id — it must apply.
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'a\n');
      docs.applyContentChange(URI, 'b\n', 'form-editor');
      expect(docs.version(URI)).toBe(2);
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'c\n' }] }, LANGUAGE_CLIENT_ID);
      expect(docs.get(URI)?.getText()).toBe('c\n');
      expect(docs.version(URI)).toBe(3);
   });

   it('applyContentChange steps the shared version, records the author, and fires a rebuild', () => {
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'a\n');
      const fires: Array<{ clientId: string; version: number }> = [];
      docs.onDidChangeContent(event => fires.push({ clientId: event.clientId, version: event.document.version }));
      const applied = docs.applyContentChange(URI, 'b\n', 'form-editor');
      expect(applied).toBe(2);
      expect(docs.version(URI)).toBe(2);
      expect(docs.get(URI)?.getText()).toBe('b\n');
      expect(docs.getAuthor(URI, 2)).toBe('form-editor');
      expect(fires).toEqual([{ clientId: 'form-editor', version: 2 }]);
   });

   it('applyContentChange keeps the version for identical content but still fires the rebuild', () => {
      // The authored-write counterpart of the language-client-only echo skip: the rebuild is
      // correctness-bearing and must fire, but no observable change happened, so
      // no new version is minted and the original author of v1 stays on record.
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'a\n');
      const fires: Array<{ clientId: string; version: number }> = [];
      docs.onDidChangeContent(event => fires.push({ clientId: event.clientId, version: event.document.version }));
      const applied = docs.applyContentChange(URI, 'a\n', 'form-editor');
      expect(applied).toBe(1);
      expect(docs.version(URI)).toBe(1);
      expect(fires).toEqual([{ clientId: 'form-editor', version: 1 }]);
      expect(docs.getAuthor(URI, 1)).toBe(LANGUAGE_CLIENT_ID);
   });

   it('applyContentChange throws for a document that is not open', () => {
      const { docs } = makeDocs();
      expect(() => docs.applyContentChange('file:///x.other', 'x\n', 'form-editor')).toThrow(/not open/);
   });

   it('resumes the same version when the document reopens with identical content', () => {
      // Close/reopen with unchanged content is NOT an observable change: the
      // sequence continues where it left off, so a watcher's `baseVersion`
      // pointer from before the close stays valid (no false conflict).
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'x\n');
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'y\n' }] }, LANGUAGE_CLIENT_ID);
      expect(docs.version(URI)).toBe(2);
      docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, LANGUAGE_CLIENT_ID);
      // Monaco reopens at ITS version 1 with the same content.
      openInLanguageClient(docs, 'y\n');
      expect(docs.version(URI)).toBe(2);
      expect(docs.get(URI)?.getText()).toBe('y\n');
   });

   it('steps the version past the pre-close value when the document reopens with different content', () => {
      // Close-with-discarded-edits: the reopened (disk) content differs from the
      // last synced state, so the version steps — a stale writer holding the
      // pre-close version can never coincidentally pass the optimistic gate.
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'x\n');
      docs.notifyDidChangeTextDocument(
         { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'edited\n' }] },
         LANGUAGE_CLIENT_ID
      );
      docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, LANGUAGE_CLIENT_ID);
      // Reopen from disk: the discarded-edit content is gone.
      openInLanguageClient(docs, 'x\n');
      expect(docs.version(URI)).toBe(3);
      expect(docs.get(URI)?.getText()).toBe('x\n');
   });

   it('reports the persisted sequence version while the document is closed', () => {
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'x\n');
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'y\n' }] }, LANGUAGE_CLIENT_ID);
      docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, LANGUAGE_CLIENT_ID);
      expect(docs.isOpen(URI)).toBe(false);
      expect(docs.version(URI)).toBe(2);
   });

   it('never adopts a large client-declared version id on a reopen', () => {
      // A long-lived Monaco model can reopen with a big version id; the shared
      // sequence must continue from ITS last value, not jump to the client's.
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'x\n');
      docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, LANGUAGE_CLIENT_ID);
      docs.notifyDidOpenTextDocument({ textDocument: { uri: URI, languageId: 'plaintext', version: 42, text: 'x\n' } }, LANGUAGE_CLIENT_ID);
      // Identical content → continuity at 1 (the client's 42 stays client-side).
      expect(docs.version(URI)).toBe(1);
      // The client's own guard still works from its declared baseline: its next
      // edit at 43 applies…
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 43 }, contentChanges: [{ text: 'y\n' }] }, LANGUAGE_CLIENT_ID);
      expect(docs.version(URI)).toBe(2);
      expect(docs.get(URI)?.getText()).toBe('y\n');
      // …and a stale packet below that baseline is dropped.
      docs.notifyDidChangeTextDocument(
         { textDocument: { uri: URI, version: 7 }, contentChanges: [{ text: 'stale\n' }] },
         LANGUAGE_CLIENT_ID
      );
      expect(docs.get(URI)?.getText()).toBe('y\n');
   });

   it('reconcileExternalContent steps the sequence for changed content while closed', () => {
      // The close-revert rebuild (and a watched-file change) swaps a CLOSED
      // document's content outside the store's write paths — the persisted
      // sequence must step so the revert broadcast and later gate reads see
      // a version consistent with the content transition.
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'x\n');
      docs.notifyDidChangeTextDocument(
         { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'edited\n' }] },
         LANGUAGE_CLIENT_ID
      );
      docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, LANGUAGE_CLIENT_ID);
      // The revert rebuild reads the pre-edit disk content.
      expect(docs.reconcileExternalContent(URI, 'x\n')).toBe(3);
      expect(docs.version(URI)).toBe(3);
      // A reopen with that content CONTINUES at the reconciled version.
      openInLanguageClient(docs, 'x\n');
      expect(docs.version(URI)).toBe(3);
   });

   it('reconcileExternalContent keeps the version for unchanged content while closed', () => {
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'x\n');
      docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, LANGUAGE_CLIENT_ID);
      expect(docs.reconcileExternalContent(URI, 'x\n')).toBe(1);
      expect(docs.version(URI)).toBe(1);
   });

   it('reconcileExternalContent is a no-op for an open document', () => {
      // While open, the store's own content is authoritative — external
      // transitions for open documents never reach the Langium factory.
      const { docs } = makeDocs();
      openInLanguageClient(docs, 'x\n');
      expect(docs.reconcileExternalContent(URI, 'other\n')).toBeUndefined();
      expect(docs.version(URI)).toBe(1);
   });

   it('consumes a stale language-client echo of a superseded push without applying it', async () => {
      // The stale-echo race: two authored writes land back-to-back; the
      // echo of the FIRST push arrives after the store already holds the
      // second. The echo's content provably equals a pending push, so it is
      // consumed — never applied over the newer store content, no version
      // minted, no rebuild fired.
      const { docs } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      openInLanguageClient(docs, 'v1\n');
      docs.applyContentChange(URI, 'v2\n', 'form-editor');
      await docs.applyEditToLanguageClient(URI, 'v2\n');
      docs.applyContentChange(URI, 'v3\n', 'form-editor');
      await docs.applyEditToLanguageClient(URI, 'v3\n');
      const fires: string[] = [];
      docs.onDidChangeContent(event => fires.push(event.clientId));
      // Monaco's late echo of the first push (its own version id 2).
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'v2\n' }] }, LANGUAGE_CLIENT_ID);
      expect(docs.get(URI)?.getText()).toBe('v3\n');
      expect(docs.version(URI)).toBe(3);
      expect(fires).toHaveLength(0);
      // The echo of the second push follows — also consumed silently.
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 3 }, contentChanges: [{ text: 'v3\n' }] }, LANGUAGE_CLIENT_ID);
      expect(docs.version(URI)).toBe(3);
      expect(fires).toHaveLength(0);
      // The per-client baseline advanced with the echoes: an older packet is stale.
      docs.notifyDidChangeTextDocument(
         { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'zombie\n' }] },
         LANGUAGE_CLIENT_ID
      );
      expect(docs.get(URI)?.getText()).toBe('v3\n');
      expect(docs.version(URI)).toBe(3);
   });

   it('applies a user edit during a pending push, and an undo back to pushed content is a real edit', async () => {
      // A real keystroke composed into Monaco's buffer makes its echo differ
      // from every pending push — it must apply as a genuine edit, and the
      // pending-echo memory resets (Monaco is no longer a pure mirror).
      // The follow-up didChange returning to the previously-pushed text is
      // the UNDO case: same content hash as an old push, higher client
      // version. It must apply as a real edit with a stepped version — safe
      // because pending entries only live between a push and its echo, and
      // Monaco's ordered didChange stream guarantees the edit that preceded
      // the undo already cleared (or never populated) the queue.
      const { docs } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      openInLanguageClient(docs, 'v1\n');
      docs.applyContentChange(URI, 'v2\n', 'form-editor');
      await docs.applyEditToLanguageClient(URI, 'v2\n');
      // Monaco applied the push, then the user typed — the echo carries both.
      docs.notifyDidChangeTextDocument(
         { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'v2\nuser\n' }] },
         LANGUAGE_CLIENT_ID
      );
      expect(docs.get(URI)?.getText()).toBe('v2\nuser\n');
      expect(docs.version(URI)).toBe(3);
      // Undo: the buffer returns to the previously-pushed text. The pending
      // entry for 'v2\n' is gone (cleared by the accepted edit above), so
      // this is a real edit — applied, version stepped, never swallowed.
      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 3 }, contentChanges: [{ text: 'v2\n' }] }, LANGUAGE_CLIENT_ID);
      expect(docs.get(URI)?.getText()).toBe('v2\n');
      expect(docs.version(URI)).toBe(4);
   });

   it('reconcileExternalContent ignores URIs the store never tracked', () => {
      // Workspace-wide builds pass every document through the reconcile
      // listener; untracked URIs must exit on a map lookup, not a hash.
      const { docs } = makeDocs();
      expect(docs.reconcileExternalContent('file:///x.other', 'x\n')).toBeUndefined();
      expect(docs.version('file:///x.other')).toBe(0);
   });
});

/**
 * The INCREMENTAL echo of a server-authored push.
 *
 * Separate from the full-text echo cases above because the two are not
 * variations of one path — a full-text echo re-applies as a no-op whatever
 * baseline it is applied to, which is why hash-only correlation classified it
 * correctly and why every earlier test here sends one. An incremental echo
 * carries ranges keyed to the client's PRE-push buffer, and the synced document
 * has already moved past that, so applying it there splices the wrong lines: a
 * line-inserting push inserted its line twice, validated cleanly, and
 * compounded on every later edit.
 *
 * Each echo below is derived from the edits the push ACTUALLY sent rather than
 * hand-written, so the fixtures cannot drift away from what `diffToEdits`
 * produces.
 */
describe('HydraniumTextDocuments incremental language-client echo', () => {
   /**
    * The edits of the single `TextDocumentEdit` a recorded push carried.
    *
    * One document per request by construction: the egress is per-URI, so a
    * write touching two files arrives as two requests rather than one batched
    * `WorkspaceEdit`.
    */
   function pushedEdits(recorded: RecordedApplyEdit): { range: Range; newText: string }[] {
      const change = recorded.params.documentChanges?.[0] as { edits: { range: Range; newText: string }[] } | undefined;
      if (change === undefined) {
         throw new Error('The push carried no documentChanges');
      }
      return change.edits;
   }

   /**
    * The `didChange` a conforming client emits after applying `edits`.
    *
    * The same ranges and texts, ordered DESCENDING by start line. That is not a
    * simplification: it is what the browser example's adapter and
    * `vscode-languageclient` both send, and the ordering is Monaco's, which
    * delivers changes back-to-front so that an earlier range stays valid while
    * a later one is being applied.
    */
   function echoOf(edits: readonly { range: Range; newText: string }[]): TextDocumentContentChangeEvent[] {
      return [...edits]
         .sort((left, right) => right.range.start.line - left.range.start.line)
         .map(edit => ({ range: edit.range, text: edit.newText }));
   }

   /** Open the client on `before`, author `after`, push it, and hand back the push's edits. */
   async function authorAndPush(
      before: string,
      after: string
   ): Promise<{
      docs: HydraniumTextDocuments<TextDocument>;
      edits: { range: Range; newText: string }[];
      fires: string[];
   }> {
      const { docs, recorded } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      openInLanguageClient(docs, before);
      docs.applyContentChange(URI, after, 'glsp');
      await docs.applyEditToLanguageClient(URI, after);
      expect(recorded).toHaveLength(1);
      const fires: string[] = [];
      // Registered after the push so the authored write's own rebuild is not
      // counted. Absolute count from here, not a delta.
      docs.onDidChangeContent(event => fires.push(event.clientId));
      return { docs, edits: pushedEdits(recorded[0]), fires };
   }

   // A diagram write that ADDS an entry — the gesture an adopter uses most, and
   // the one that corrupted. The trailing brace is what makes the inserted
   // region's range span two lines, so a re-application is destructive rather
   // than idempotent.
   const ONE_NODE = 'diagram Flow {\n   node A at 10, 10\n}\n';
   const TWO_NODES = 'diagram Flow {\n   node A at 10, 10\n   node B at 20, 20\n}\n';

   it('does not re-apply the echo of a line-INSERTING push', async () => {
      const { docs, edits, fires } = await authorAndPush(ONE_NODE, TWO_NODES);

      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 2 }, contentChanges: echoOf(edits) }, LANGUAGE_CLIENT_ID);

      // Byte-identical to the authored text: the echo told us the client caught
      // up, and told us nothing else.
      expect(docs.get(URI)?.getText()).toBe(TWO_NODES);
      // No version minted, so an optimistic `baseVersion` holder is not
      // false-conflicted by the client agreeing with us.
      expect(docs.version(URI)).toBe(2);
      expect(fires).toHaveLength(0);
   });

   it('does not re-apply the echo of a line-DELETING push', async () => {
      // The mirror case, and the one that was LOUD: re-applying a deletion
      // removes a different set of lines, which parses as a syntax error the
      // next write happens to repair. Loud but still wrong.
      const WITH_HEADER = `// generated, do not edit\n// second header line\n${ONE_NODE}`;
      const { docs, edits, fires } = await authorAndPush(WITH_HEADER, ONE_NODE);

      docs.notifyDidChangeTextDocument({ textDocument: { uri: URI, version: 2 }, contentChanges: echoOf(edits) }, LANGUAGE_CLIENT_ID);

      expect(docs.get(URI)?.getText()).toBe(ONE_NODE);
      expect(docs.version(URI)).toBe(2);
      expect(fires).toHaveLength(0);
   });

   it('consumes the echo of a superseded push, and every older one it accounts for', async () => {
      // Two authored writes back to back, both pushed, and only the SECOND
      // echo arrives — the client coalesced or the first was dropped. Matching
      // the reconstruction against every pending push, not only the oldest, is
      // what recognises it; matching the oldest alone would call this divergent
      // and adopt a reconstruction built from a stale baseline.
      const THREE_NODES = `diagram Flow {\n   node A at 10, 10\n   node B at 20, 20\n   node C at 30, 30\n}\n`;
      const { docs, recorded } = makeDocs({ workspace: { applyEdit: async () => ({ applied: true }) } });
      openInLanguageClient(docs, ONE_NODE);
      docs.applyContentChange(URI, TWO_NODES, 'glsp');
      await docs.applyEditToLanguageClient(URI, TWO_NODES);
      docs.applyContentChange(URI, THREE_NODES, 'glsp');
      await docs.applyEditToLanguageClient(URI, THREE_NODES);
      expect(recorded).toHaveLength(2);
      const fires: string[] = [];
      docs.onDidChangeContent(event => fires.push(event.clientId));

      // The client applied BOTH pushes and reports the combined result once, so
      // its ranges are keyed to the buffer before the FIRST of them.
      docs.notifyDidChangeTextDocument(
         {
            textDocument: { uri: URI, version: 2 },
            contentChanges: [{ range: Range.create(2, 0, 3, 0), text: '   node B at 20, 20\n   node C at 30, 30\n}\n' }]
         },
         LANGUAGE_CLIENT_ID
      );

      expect(docs.get(URI)?.getText()).toBe(THREE_NODES);
      expect(docs.version(URI)).toBe(3);
      expect(fires).toHaveLength(0);
   });

   it('adopts the reconstruction when the client typed before the push landed', async () => {
      // The client's change is keyed to the pre-push baseline but produces text
      // we never pushed — a keystroke that overtook the `applyEdit`. The
      // reconstruction is what the client actually holds, and it is
      // authoritative: the synced document mirrors an OPEN client's buffer, so
      // it cannot claim a push the client has not applied. The push itself is
      // then refused by the client's own version gate, which invalidates the
      // shadow and makes the next sync a position-independent full replace.
      const { docs, fires } = await authorAndPush(ONE_NODE, TWO_NODES);

      docs.notifyDidChangeTextDocument(
         {
            textDocument: { uri: URI, version: 2 },
            // Appending at the end of the PRE-push text, which is a position
            // that no longer exists in the authored text.
            contentChanges: [{ range: Range.create(3, 0, 3, 0), text: '// typed\n' }]
         },
         LANGUAGE_CLIENT_ID
      );

      expect(docs.get(URI)?.getText()).toBe(`${ONE_NODE}// typed\n`);
      // A real edit, so the version steps and the rebuild fires — unlike an echo.
      expect(docs.version(URI)).toBe(3);
      expect(fires).toEqual([LANGUAGE_CLIENT_ID]);
   });

   it('applies an ordinary incremental edit untouched when nothing is in flight', () => {
      // Deliberately reaches the in-flight machinery not at all: no push, empty
      // queue, a plain user keystroke. Every other language-client test in this
      // file sends a FULL-TEXT change, so without this one the ordinary
      // incremental path — the overwhelmingly common one — has no coverage at
      // all, and a reconstruction that leaked into it would break silently.
      // It is a non-regression guard rather than a discriminator: it stays
      // GREEN under the control below, which is what says the change is scoped
      // to a push being in flight.
      const { docs } = makeDocs();
      openInLanguageClient(docs, TWO_NODES);

      docs.notifyDidChangeTextDocument(
         { textDocument: { uri: URI, version: 2 }, contentChanges: [{ range: Range.create(1, 17, 1, 19), text: '99' }] },
         LANGUAGE_CLIENT_ID
      );

      expect(docs.get(URI)?.getText()).toBe('diagram Flow {\n   node A at 10, 99\n   node B at 20, 20\n}\n');
      expect(docs.version(URI)).toBe(2);
   });
});

describe('HydraniumTextDocuments URI normalization', () => {
   // LSP clients normally send already-percent-encoded URIs, so raw === normalized
   // and the gap below never bites in practice. But the manager keeps its own state
   // (the per-URI `__documents` tracking record and the shadow) alongside the
   // inherited NormalizedTextDocuments store, whose get/set/delete normalize the
   // key. If the manager keyed that state by the raw event URI, a non-canonical URI
   // would be stored under one key but read back under another by the inherited
   // get() (and by version(), which is built on it). This pins that every entry
   // point canonicalizes the URI like the base class.
   const RAW = 'file:///My Folder/a.x';
   const CANONICAL = 'file:///My%20Folder/a.x';

   it('keys all state under the normalized URI so raw and canonical lookups agree', () => {
      const { docs } = makeDocs();
      docs.notifyDidOpenTextDocument({ textDocument: { uri: RAW, languageId: 'plaintext', version: 1, text: 'x\n' } }, LANGUAGE_CLIENT_ID);
      // The inherited normalized get() — and version(), which builds on it — must
      // find the document even though it was opened under the non-canonical form.
      expect(docs.version(CANONICAL)).toBe(1);
      expect(docs.get(CANONICAL)?.getText()).toBe('x\n');
      // The manager's own maps must agree whether queried with either spelling.
      expect(docs.isOpen(RAW)).toBe(true);
      expect(docs.isOpen(CANONICAL)).toBe(true);
      expect(docs.isOpenInLanguageClient(CANONICAL)).toBe(true);
      expect(docs.isOpenInAnyClient(RAW)).toBe(true);
      expect(docs.getAuthor(CANONICAL, 1)).toBe(LANGUAGE_CLIENT_ID);
      // The stored document carries the canonical URI, matching the Langium index.
      expect(docs.get(RAW)?.uri).toBe(CANONICAL);
   });
});

describe('HydraniumTextDocuments get() — canonical lookup (symlink divergence)', () => {
   // With a realpath-style canonicalizer a symlinked file opened under path S has
   // canonical identity R≠S. The store keys synced docs by their CANONICAL identity
   // (documentKey), so a client-space caller addressing the symlink path S misses
   // the normalized fast path; `get` then falls back to the single canonical lookup
   // (documentKey(S) === R), so the rebuild sources the client's live text instead
   // of stale disk. (Inbound counterpart to the applyEditToLanguageClient egress.)
   const REAL = 'file:///real/a.x';
   const LINK = 'file:///link/a.x';
   const toText = (uri: string | { toString(): string }): string => (typeof uri === 'string' ? uri : uri.toString());
   const linkAware = {
      canonicalUri: (uri: string | { toString(): string }): string => (toText(uri) === LINK ? REAL : toText(uri)),
      loadUri: (uri: string | { toString(): string }) => ({ toString: () => (toText(uri) === LINK ? REAL : toText(uri)) })
   };

   function makeStore(): HydraniumTextDocuments<TextDocument> {
      const logger = makeLogger();
      const services = {
         Logger: { for: () => logger },
         Tracer: { for: () => logger },
         workspace: {
            LangiumDocuments: { getDocument: () => undefined },
            DocumentBuilder: { update: () => undefined, resetToState: () => undefined },
            WorkspaceManager: { workspaceInitialized: Promise.resolve() },
            DocumentUriPolicy: linkAware
         }
      } as unknown as ServerSharedServices;
      return new HydraniumTextDocuments<TextDocument>(services);
   }

   it('resolves a canonical (real-path) URI to a doc opened under the symlink path', () => {
      const docs = makeStore();
      docs.notifyDidOpenTextDocument({ textDocument: { uri: LINK, languageId: 'plaintext', version: 1, text: 'x\n' } }, LANGUAGE_CLIENT_ID);
      // Direct (client-space) lookup still works…
      expect(docs.get(LINK)?.getText()).toBe('x\n');
      // …and the canonical lookup the build uses reverse-matches to the same doc.
      expect(docs.get(REAL)?.getText()).toBe('x\n');
   });

   it('returns undefined for a canonical URI with no open synced doc', () => {
      const docs = makeStore();
      expect(docs.get(REAL)).toBeUndefined();
   });

   function makeConnectedStore(): { docs: HydraniumTextDocuments<TextDocument>; recorded: RecordedApplyEdit[] } {
      const recorded: RecordedApplyEdit[] = [];
      const logger = makeLogger();
      const services = {
         lsp: { Connection: { workspace: { applyEdit: async (params: WorkspaceEdit) => (recorded.push({ params }), { applied: true }) } } },
         Logger: { for: () => logger },
         Tracer: { for: () => logger },
         workspace: {
            LangiumDocuments: { getDocument: () => undefined },
            DocumentBuilder: { update: () => undefined, resetToState: () => undefined },
            WorkspaceManager: { workspaceInitialized: Promise.resolve() },
            DocumentUriPolicy: linkAware
         }
      } as unknown as ServerSharedServices;
      return { docs: new HydraniumTextDocuments<TextDocument>(services), recorded };
   }

   const targetUriOf = (rec: RecordedApplyEdit): string =>
      (rec.params.documentChanges![0] as { textDocument: { uri: string } }).textDocument.uri;

   it('addresses a server push at the CLIENT spelling even when pushed under the canonical URI', async () => {
      const { docs, recorded } = makeConnectedStore();
      // Monaco opened the file under the symlink path S.
      docs.notifyDidOpenTextDocument(
         { textDocument: { uri: LINK, languageId: 'plaintext', version: 1, text: 'a\nb\n' } },
         LANGUAGE_CLIENT_ID
      );
      // The build pushes settled text addressed by the canonical real path R (document.uri).
      await docs.applyEditToLanguageClient(REAL, 'a\nB\n');
      // The applyEdit must target the URI Monaco actually opened (S = LINK), not R.
      expect(recorded).toHaveLength(1);
      expect(targetUriOf(recorded[0])).toBe(LINK);
      // ...and the diff is computed against the client baseline (a minimal edit, not a full replace).
      const edits = (recorded[0].params.documentChanges![0] as { edits: Array<{ newText: string }> }).edits;
      expect(edits[edits.length - 1].newText).not.toBe('a\nB\n');
   });

   it('fans a server push out to every spelling the language client opened the file under', async () => {
      const { docs, recorded } = makeConnectedStore();
      // Monaco opens the SAME file in two tabs — one under the symlink path, one under the real path.
      docs.notifyDidOpenTextDocument(
         { textDocument: { uri: LINK, languageId: 'plaintext', version: 1, text: 'a\nb\n' } },
         LANGUAGE_CLIENT_ID
      );
      docs.notifyDidOpenTextDocument(
         { textDocument: { uri: REAL, languageId: 'plaintext', version: 1, text: 'a\nb\n' } },
         LANGUAGE_CLIENT_ID
      );
      // A settled-text push reaches BOTH tabs, each addressed at its own spelling.
      await docs.applyEditToLanguageClient(REAL, 'a\nB\n');
      expect(recorded.map(targetUriOf).sort()).toEqual([LINK, REAL].sort());
   });

   it('treats a file opened under both its symlink and real path as one document', () => {
      const docs = makeStore();
      // Open the SAME physical file under the symlink path (S) and the real path (R).
      docs.notifyDidOpenTextDocument(
         { textDocument: { uri: LINK, languageId: 'plaintext', version: 1, text: 'shared\n' } },
         LANGUAGE_CLIENT_ID
      );
      docs.notifyDidOpenTextDocument(
         { textDocument: { uri: REAL, languageId: 'plaintext', version: 1, text: 'shared\n' } },
         LANGUAGE_CLIENT_ID
      );
      // An edit via the symlink spelling...
      docs.notifyDidChangeTextDocument(
         { textDocument: { uri: LINK, version: 2 }, contentChanges: [{ text: 'edited\n' }] },
         LANGUAGE_CLIENT_ID
      );
      // ...is visible when read via the real-path spelling: it is one document, not two
      // divergent registrations. (Under client-keyed storage these would be separate docs
      // and the real-path read would still see the stale 'shared\n'.)
      expect(docs.get(REAL)?.getText()).toBe('edited\n');
      expect(docs.get(LINK)?.getText()).toBe('edited\n');
   });

   it('isOpenInLanguageClient reports a divergently-opened file open under its canonical URI', () => {
      const docs = makeStore();
      // Opened in the language client under the symlink path S. The outbound sync
      // routes on this presence question keyed by the canonical real path R, so it
      // must recognise the divergent open — the record is keyed by R either way.
      docs.notifyDidOpenTextDocument({ textDocument: { uri: LINK, languageId: 'plaintext', version: 1, text: 'x\n' } }, LANGUAGE_CLIENT_ID);
      expect(docs.isOpenInLanguageClient(REAL)).toBe(true);
      expect(docs.isOpenInLanguageClient(LINK)).toBe(true);
   });

   it('isOpenInLanguageClient is false when a file is open only in a non-language client', () => {
      const docs = makeStore();
      docs.notifyDidOpenTextDocument({ textDocument: { uri: LINK, languageId: 'plaintext', version: 1, text: 'x\n' } }, 'form-client');
      expect(docs.isOpenInLanguageClient(REAL)).toBe(false);
      expect(docs.isOpenInLanguageClient(LINK)).toBe(false);
   });
});
