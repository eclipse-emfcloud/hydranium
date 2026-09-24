/********************************************************************************
 * Copyright (c) 2026 CrossBreeze.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Where an integrity repair lands when the URI is open in the text store.
 *
 * The contract is not "the AST was corrected" — that holds even when nothing
 * reaches the reader. It is that the OPEN EDITOR ends up on the repaired text:
 * the store (the server's authority on what an open document says), the built
 * document, and the `TextEdit`s the client is sent, which must land on the
 * repaired text when applied to the buffer the client actually holds.
 *
 * Two shapes reach the resync with an open URI, and they differ in one way that
 * decides the outcome. On the LSP path the Langium document's `textDocument` IS
 * the store's object, so repairing it in place repairs the store. A document
 * built separately for an already-open URI — `LangiumDocumentFactory.fromString`,
 * which is what Langium's `parseHelper` calls — carries its own text-document
 * object instead, so a repair written into it never reaches the store, and the
 * re-parse that follows redefines `textDocument` onto the store's object and
 * discards it.
 *
 * A real store, a real builder and a captured LSP `applyEdit` throughout: a stub
 * store cannot show the divergence, because the divergence IS between two
 * objects the store does and does not know about.
 */

import { DefaultIntegrityService, HydraniumTextDocuments } from '@hydranium/core';
import { DefaultFileSystemProvider } from '@hydranium/core/node';
import { DocumentState, URI } from '@hydranium/langium';
import { asSnapshotVersion } from '@hydranium/protocol';
import { readFileSync, writeFileSync } from 'node:fs';
import type { ApplyWorkspaceEditParams, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { afterEach, describe, expect, it } from 'vitest';
import { isDomainModel } from '../src/language-server/ast.js';
import { makeScratchWorkspaceHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';

const FILE = 'open-repair.domain';
/** A second name, for the case that needs a URI the workspace scan never saw. */
const UNINDEXED = 'open-repair-separate.domain';
const CLEAN = `entity Solo {
   a : string
}
`;
/** Two declarations with one name: `UniqueDeclarationNamesRule` suffixes the second. */
const DUPLICATES = `entity Twin {
   a : string
}

entity Twin {
   b : string
}
`;

let scratch: ScratchOrderFlowHarness | undefined;
let recorded: ApplyWorkspaceEditParams[] = [];
let propagated: string[] = [];
let staged: string[] = [];
/** Runs once a file read completes, before its reader continues; cleared per test. */
let afterRead: ((uri: string) => Promise<void>) | undefined;

afterEach(() => {
   scratch?.workspace.dispose();
   scratch = undefined;
   recorded = [];
   propagated = [];
   staged = [];
   afterRead = undefined;
});

/**
 * Records every text a correction is handed on to propagation with. Disk shows
 * a stale repair only in silent mode, and only while disk holds the text the
 * repair was computed from; the hand-off is what an override persisting from
 * `syncCorrections` would write over a newer edit in any mode. Both arguments
 * are forwarded: dropping `parsedFrom` turns off the silent write for a held
 * URI.
 */
class PropagationRecordingIntegrityService extends DefaultIntegrityService {
   protected override async syncCorrections(document: TextDocument, parsedFrom?: string): Promise<void> {
      propagated.push(document.getText());
      await super.syncCorrections(document, parsedFrom);
   }
}

/**
 * Lets a test act in the gap between a read completing and its reader using
 * the result, which is where a write that depends on the read can be raced.
 */
class InterleavingFileSystemProvider extends DefaultFileSystemProvider {
   override async readFile(uri: URI): Promise<string> {
      const content = await super.readFile(uri);
      if (afterRead !== undefined) {
         await afterRead(uri.toString());
      }
      return content;
   }
}

/**
 * Records every stage. For a URI a client holds, a stage is never read — only
 * a first open consumes one — so its only observable is the call itself.
 */
class StageRecordingTextDocuments extends HydraniumTextDocuments<TextDocument> {
   override stagePendingContent(uri: string, text: string): void {
      staged.push(text);
      super.stagePendingContent(uri, text);
   }
}

/** Poll until `predicate` holds, so a coalesced sync is awaited rather than raced. */
async function until(predicate: () => boolean, what: string): Promise<void> {
   for (let attempt = 0; attempt < 200; attempt++) {
      if (predicate()) {
         return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
   }
   throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Boot over a throwaway workspace with `syncMode` bound, the LSP `applyEdit`
 * captured, and propagations and stages recorded. Unless `seed` writes it, the
 * file is NOT seeded before init: the separately-parsed case needs
 * a URI the workspace scan never indexed, because `LangiumDocuments.addDocument`
 * refuses one that is already present.
 */
async function bootCapturing(
   syncMode: 'editor' | 'silent',
   seed?: (workspace: ScratchWorkspace) => void
): Promise<ScratchOrderFlowHarness['harness']> {
   scratch = await makeScratchWorkspaceHarness(seed, {
      extraSharedModules: [
         {
            lsp: {
               Connection: () =>
                  ({
                     workspace: {
                        applyEdit: async (params: ApplyWorkspaceEditParams) => {
                           recorded.push(params);
                           return { applied: true };
                        }
                     }
                  }) as never
            },
            workspace: {
               TextDocuments: services => new StageRecordingTextDocuments(services),
               FileSystemProvider: services => new InterleavingFileSystemProvider(services)
            }
         }
      ],
      extraLanguageModules: [
         { integrity: { IntegrityService: services => new PropagationRecordingIntegrityService(services, { syncMode }) } }
      ]
   });
   // Arm the mirror: `ModelService` registers the settled listener that syncs to
   // the language client, and Langium constructs a slot only when something
   // resolves it.
   void scratch.harness.shared.model.ModelService;
   return scratch.harness;
}

/** The declaration names on the document currently registered for `uri`. */
function declarationNames(harness: ScratchOrderFlowHarness['harness'], uri: URI): string[] {
   const root = harness.shared.workspace.LangiumDocuments.getDocument(uri)?.parseResult.value;
   return root !== undefined && isDomainModel(root) ? root.declarations.map(declaration => declaration.name) : [];
}

/** What the client would hold after applying the edits the server sent it. */
function clientTextAfterEdits(uri: URI, original: string): string {
   expect(recorded.length).toBeGreaterThan(0);
   const edits = (recorded.at(-1)!.edit.documentChanges![0] as { edits: TextEdit[] }).edits;
   return TextDocument.applyEdits(TextDocument.create(uri.toString(), 'domain', 1, original), edits);
}

/**
 * A repair computed against text the store has already replaced.
 *
 * The freshness question is not "does the object I am holding still say what I
 * think" — on the LSP path that object IS the store's, so asking it compares the
 * store against itself and can only ever agree. It is "does the store still hold
 * the text this AST was parsed from", and the only honest reference for that is
 * the CST's own `fullText`.
 *
 * Only a URI open in the store can be stale — a closed one has no newer text to
 * lose to. Held by a data head in silent mode, with disk still holding the
 * superseded text, a stale repair that reached propagation would be written to
 * disk, so disk witnesses the guard here. Whether the stale repair reaches
 * `syncCorrections` at all is the part that holds for any mode and any disk:
 * an override persisting from there would overwrite a newer edit with a
 * correction computed before it existed.
 */
describe('an integrity repair whose source text the store has already replaced', () => {
   const NEWER = `entity Twin {
   a : string
}

entity Renamed {
   b : string
}
`;

   it('is abandoned rather than persisted over the newer text', async () => {
      const harness = await bootCapturing('silent');
      const workspace = scratch!.workspace;
      const uri = URI.file(workspace.resolve(UNINDEXED));
      const uriString = uri.toString();
      writeFileSync(workspace.resolve(UNINDEXED), DUPLICATES, 'utf8');
      const textDocuments = harness.shared.workspace.TextDocuments;

      textDocuments.notifyDidOpenTextDocument(
         { textDocument: { uri: uriString, languageId: 'domain', version: 1, text: DUPLICATES } },
         'data-client'
      );
      const separate = harness.shared.workspace.LangiumDocumentFactory.fromString(DUPLICATES, uri);
      harness.shared.workspace.LangiumDocuments.addDocument(separate);

      // The editor's next edit lands BEFORE the build that repairs the parse of
      // the previous one — the race this guard exists for.
      textDocuments.applyContentChange(uriString, NEWER, 'data-client');
      await harness.shared.workspace.DocumentBuilder.build([separate], { validation: true });

      // The store keeps the newer text, and nothing derived from the superseded
      // parse is handed on to be persisted or staged — or reaches disk, which
      // still holds the text that parse came from.
      expect(textDocuments.get(uriString)?.getText()).toBe(NEWER);
      expect(propagated.filter(text => text.includes('Twin__1'))).toEqual([]);
      expect(readFileSync(workspace.resolve(UNINDEXED), 'utf8')).toBe(DUPLICATES);
   });

   it('leaves the registered document describing the newer text, not the repair', async () => {
      // Abandoning the write is only half of it. The build carries on to its
      // settled phase with whatever AST is registered, and every settled
      // consumer — the language-client sync, a save, a diagram load — reads that
      // AST rather than the store. An abandoned repair left in place is a
      // document the server will answer questions about using a parse of text
      // nobody has.
      const harness = await bootCapturing('silent');
      const workspace = scratch!.workspace;
      const uri = URI.file(workspace.resolve(UNINDEXED));
      const uriString = uri.toString();
      writeFileSync(workspace.resolve(UNINDEXED), DUPLICATES, 'utf8');
      const textDocuments = harness.shared.workspace.TextDocuments;

      textDocuments.notifyDidOpenTextDocument(
         { textDocument: { uri: uriString, languageId: 'domain', version: 1, text: DUPLICATES } },
         'data-client'
      );
      const separate = harness.shared.workspace.LangiumDocumentFactory.fromString(DUPLICATES, uri);
      harness.shared.workspace.LangiumDocuments.addDocument(separate);

      textDocuments.applyContentChange(uriString, NEWER, 'data-client');
      await harness.shared.workspace.DocumentBuilder.build([separate], { validation: true });

      // `Renamed` is what the newer text declares; `Twin__1` is the repair the
      // superseded parse produced and which nothing should still be carrying.
      expect(declarationNames(harness, uri)).toEqual(['Twin', 'Renamed']);
   });
});

for (const syncMode of ['editor', 'silent'] as const) {
   describe(`an integrity repair of a URI open in the store (${syncMode} mode)`, () => {
      // Both modes are covered because the open/closed branch is what selects
      // between them, and an open document must take neither: a repair delivered
      // to an editor is delivered by content, and writing it to disk underneath
      // that editor is the failure the branch exists to avoid.

      it('reaches the store, the document and the client on the normal open/edit path', async () => {
         // Seeded before init, so the workspace scan indexes it and there is a
         // Langium document for the open to drive a build on.
         const harness = await bootCapturing(syncMode, workspace => workspace.write(FILE, CLEAN));
         const workspace = scratch!.workspace;
         const uri = URI.file(workspace.resolve(FILE));
         const uriString = uri.toString();
         const textDocuments = harness.shared.workspace.TextDocuments;
         const builder = harness.shared.workspace.DocumentBuilder;

         textDocuments.notifyDidOpenTextDocument({
            textDocument: { uri: uriString, languageId: 'domain', version: 1, text: CLEAN }
         });
         await builder.waitUntil(DocumentState.Validated, uri);

         // The client introduces the duplicate, so the repair happens while the
         // document is held open and the store owns its text.
         textDocuments.notifyDidChangeTextDocument({
            textDocument: { uri: uriString, version: 2 },
            contentChanges: [{ text: DUPLICATES }]
         });
         // Driven directly, because nothing routes the store's change event to
         // the builder without a real LSP connection wired to it.
         await builder.update([uri], []);
         await builder.waitUntil(DocumentState.Validated, uri);
         await until(() => declarationNames(harness, uri).includes('Twin__1'), 'the duplicate to be repaired');

         const document = harness.shared.workspace.LangiumDocuments.getDocument(uri)!;
         expect(textDocuments.get(uriString)?.getText()).toContain('Twin__1');
         expect(document.textDocument.getText()).toContain('Twin__1');
         expect(document.parseResult.value.$cstNode?.root.fullText).toBe(textDocuments.get(uriString)?.getText());

         await until(() => recorded.length > 0, 'the repair to be mirrored to the language client');
         expect(clientTextAfterEdits(uri, DUPLICATES)).toBe(textDocuments.get(uriString)?.getText());

         // An open editor owns the buffer; persisting underneath it would make
         // disk and editor disagree about a file the user is holding.
         expect(readFileSync(workspace.resolve(FILE), 'utf8')).toBe(CLEAN);
      });

      it('reaches the store, the document and the client for a separately parsed document', async () => {
         const harness = await bootCapturing(syncMode);
         const workspace = scratch!.workspace;
         const uri = URI.file(workspace.resolve(UNINDEXED));
         const uriString = uri.toString();
         // Written after boot so the workspace scan never indexed it, which is
         // what leaves `addDocument` free to take the separately parsed one.
         writeFileSync(workspace.resolve(UNINDEXED), DUPLICATES, 'utf8');
         const textDocuments = harness.shared.workspace.TextDocuments;

         // Open in the store, as a client would.
         textDocuments.notifyDidOpenTextDocument({
            textDocument: { uri: uriString, languageId: 'domain', version: 1, text: DUPLICATES }
         });

         // Now build a SEPARATE document for that same URI — the `parseHelper`
         // shape — which carries its own text-document object.
         const separate = harness.shared.workspace.LangiumDocumentFactory.fromString(DUPLICATES, uri);
         harness.shared.workspace.LangiumDocuments.addDocument(separate);
         expect(separate.textDocument).not.toBe(textDocuments.get(uriString));
         await harness.shared.workspace.DocumentBuilder.build([separate], { validation: true });

         expect(declarationNames(harness, uri)).toEqual(['Twin', 'Twin__1']);
         expect(textDocuments.get(uriString)?.getText()).toContain('Twin__1');
         expect(separate.textDocument.getText()).toContain('Twin__1');
         expect(harness.shared.workspace.LangiumDocuments.getDocument(uri)?.parseResult.value.$cstNode?.root.fullText).toBe(
            textDocuments.get(uriString)?.getText()
         );

         await until(() => recorded.length > 0, 'the repair to be mirrored to the language client');
         expect(clientTextAfterEdits(uri, DUPLICATES)).toBe(textDocuments.get(uriString)?.getText());

         expect(readFileSync(workspace.resolve(UNINDEXED), 'utf8')).toBe(DUPLICATES);
      });
   });

   describe(`an integrity repair of a URI held only through the data head (${syncMode} mode)`, () => {
      // Not a closed file, though no editor holds it: the store is the
      // authority, and it carries the client's unsaved updates. Routing it as
      // closed writes those updates to disk in silent mode whenever an edit
      // happens to need a repair, and in editor mode stages text no open reads.

      it('stays in the store, neither persisted nor staged, until a save writes it', async () => {
         const harness = await bootCapturing(syncMode, workspace => workspace.write(FILE, CLEAN));
         const workspace = scratch!.workspace;
         const uri = URI.file(workspace.resolve(FILE));
         const uriString = uri.toString();
         const textDocuments = harness.shared.workspace.TextDocuments;
         const builder = harness.shared.workspace.DocumentBuilder;
         const modelService = harness.shared.model.ModelService;
         const onDisk = (): string => readFileSync(workspace.resolve(FILE), 'utf8');

         await modelService.open({ uri: uriString, clientId: 'data-client' });
         await builder.waitUntil(DocumentState.Validated, uri);

         // An unsaved update that needs a repair. `update` resolves at the
         // settled phase, past both integrity passes, and `Validated` follows
         // every settled-phase listener — so each place a repair could be
         // persisted or staged has already run.
         await modelService.update({ uri: uriString, clientId: 'data-client', model: DUPLICATES, basedOn: 'anything' });
         await builder.waitUntil(DocumentState.Validated, uri);

         expect(textDocuments.get(uriString)?.getText()).toContain('Twin__1');
         expect(onDisk()).toBe(CLEAN);
         expect(staged).toEqual([]);

         // Saved as the text the store already holds, gated on the version that
         // carries the repair. The version is the discriminating observable:
         // saving the unrepaired payload again would step it and have the rule
         // repair afresh, and the rename is deterministic, so disk alone would
         // read the same either way.
         const held = textDocuments.get(uriString)!.getText();
         const heldVersion = textDocuments.version(uriString);
         await modelService.save({ uri: uriString, clientId: 'data-client', model: held, basedOn: asSnapshotVersion(heldVersion) });

         expect(textDocuments.version(uriString)).toBe(heldVersion);
         expect(onDisk()).toBe(held);
      });

      it('reaches disk in silent mode when the store held nothing unsaved', async () => {
         // A repair the holder did not author: the defect reached disk without
         // the server seeing it, and the first open repairs it. Nothing the
         // holder could discard rides along, and no client marks the repair as
         // unsaved, so waiting for a save would leave disk and store apart with
         // nothing showing it.
         //
         // Editor mode does wait, and that gap is a known limitation rather
         // than a guarantee: the repair stays in the store alone, unmarked,
         // until a save or the last close. Writing it would break the mode's
         // promise that a user sees a repair before disk does, and there is no
         // editor here to show it in.
         const harness = await bootCapturing(syncMode, workspace => workspace.write(FILE, CLEAN));
         const workspace = scratch!.workspace;
         const uri = URI.file(workspace.resolve(FILE));
         const uriString = uri.toString();
         const textDocuments = harness.shared.workspace.TextDocuments;
         const onDisk = (): string => readFileSync(workspace.resolve(FILE), 'utf8');
         writeFileSync(workspace.resolve(FILE), DUPLICATES, 'utf8');

         // `open` builds the document, and `Validated` follows both integrity
         // passes and every settled-phase listener.
         await harness.shared.model.ModelService.open({ uri: uriString, clientId: 'data-client' });
         await harness.shared.workspace.DocumentBuilder.waitUntil(DocumentState.Validated, uri);

         const repaired = textDocuments.get(uriString)?.getText();
         expect(repaired).toContain('Twin__1');
         expect(staged).toEqual([]);
         expect(onDisk()).toBe(syncMode === 'silent' ? repaired : DUPLICATES);
      });
   });
}

describe('a silent repair of a held URI whose source is what disk holds', () => {
   const SAVED_EDIT = `entity Solo {
   a : string
   b : string
}
`;

   it('is not written over an edit saved while disk was being read', async () => {
      // The write depends on a disk read, and a save does not wait for the
      // build that repair belongs to: a diagram flush saves straight through the
      // manager. An edit and its save landing in that gap are newer than the
      // repair, and disk must keep them.
      const harness = await bootCapturing('silent', workspace => workspace.write(FILE, CLEAN));
      const workspace = scratch!.workspace;
      const uri = URI.file(workspace.resolve(FILE));
      const uriString = uri.toString();
      const textDocuments = harness.shared.workspace.TextDocuments;
      const manager = harness.shared.workspace.AstDocumentManager;
      writeFileSync(workspace.resolve(FILE), DUPLICATES, 'utf8');

      afterRead = async target => {
         // The integrity pass's read, not the one `open` makes before the store
         // has the document.
         if (target !== uriString || !textDocuments.isOpen(uriString)) {
            return;
         }
         afterRead = undefined;
         manager.update(uriString, SAVED_EDIT, 'data-client');
         await manager.save(uriString, 'data-client');
      };
      // `Validated` for the document follows the integrity passes of the build
      // `open` drives; the builder-wide wait then covers the one the edit drives.
      await harness.shared.model.ModelService.open({ uri: uriString, clientId: 'data-client' });
      await harness.shared.workspace.DocumentBuilder.waitUntil(DocumentState.Validated, uri);
      await harness.shared.model.ModelService.waitForBuilderState(DocumentState.Validated);

      // The edit and its save did land inside the gap.
      expect(afterRead).toBeUndefined();
      expect(textDocuments.get(uriString)?.getText()).toBe(SAVED_EDIT);
      expect(readFileSync(workspace.resolve(FILE), 'utf8')).toBe(SAVED_EDIT);
   });
});
