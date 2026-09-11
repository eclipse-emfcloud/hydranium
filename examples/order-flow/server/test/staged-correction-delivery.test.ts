/********************************************************************************
 * Copyright (c) 2026 CrossBreeze.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Whether a correction an integrity rule makes to a CLOSED document reaches the
 * editor that later opens that file, with the integrity tier in `'editor'`
 * sync mode.
 *
 * Every layer has to be the real one for the question to be asked at all: a
 * real `DocumentBuilder`, because the repair happens during its `Parsed` phase
 * and staging is a side effect of that build; a real `Serializer`, because a
 * mutated AST becomes text through no other route; and a bound
 * `lsp.Connection`, because the egress returns `undefined` without one, which a
 * test would otherwise read as "nothing needed sending".
 *
 * The client opens the file from DISK, so it holds the pre-repair text while
 * the server holds the staged repair. The open's own sync is the only delivery
 * this path has — nothing else will ever tell the editor.
 */

import { DefaultIntegrityService } from '@hydranium/core';
import { DocumentState, URI } from '@hydranium/langium';
import type { ApplyWorkspaceEditParams, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { afterEach, describe, expect, it } from 'vitest';
import { makeScratchWorkspaceHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const DUPLICATES = 'staged-correction.domain';
/** Two declarations with one name: `UniqueDeclarationNamesRule` suffixes the second. */
const ON_DISK = `entity Staged {
   a : string
}

entity Staged {
   b : string
}
`;

let scratch: ScratchOrderFlowHarness | undefined;

afterEach(() => {
   scratch?.workspace.dispose();
   scratch = undefined;
});

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

describe('a staged integrity correction reaches the client that opens the file', () => {
   it('sends the repaired text to a client whose buffer is the unrepaired file', async () => {
      const recorded: ApplyWorkspaceEditParams[] = [];
      scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(DUPLICATES, ON_DISK), {
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
               }
            }
         ],
         // The whole point of the suite: the framework's own module constructs
         // `IntegrityService` with no options, so silent mode (write to disk) is
         // the only reachable closed-file behaviour until the slot is rebound.
         extraLanguageModules: [
            {
               integrity: {
                  IntegrityService: services => new DefaultIntegrityService(services, { syncMode: 'editor' })
               }
            }
         ]
      });
      const { harness, workspace } = scratch;
      const uri = URI.file(workspace.resolve(DUPLICATES));

      // The initial build repaired the duplicate while no client held the file,
      // so the repair is staged rather than written to disk.
      // The AST is where that repair is legible, so read it back by serialising:
      // the Parsed-phase resync re-reads disk, where nothing was written, which
      // leaves `textDocument` holding the unrepaired text while skipping the
      // re-parse that would have discarded the mutation.
      const document = harness.shared.workspace.LangiumDocuments.getDocument(uri);
      const repaired = await harness.domain.serializer.Serializer.serializeAst(document!.parseResult.value);
      expect(repaired).toContain('Staged__1');

      // Arm the mirror before the open: `ModelService` registers the settled
      // listener that performs the sync, and Langium constructs a slot only when
      // something resolves it.
      void harness.shared.model.ModelService;

      // The client opens the file, reading the unrepaired text from disk.
      harness.shared.workspace.TextDocuments.notifyDidOpenTextDocument({
         textDocument: { uri: uri.toString(), languageId: 'domain', version: 1, text: ON_DISK }
      });
      await harness.shared.workspace.DocumentBuilder.waitUntil(DocumentState.Validated, uri);
      await until(() => recorded.length > 0, 'the open to be mirrored to the language client');

      // Applying what was sent to what the client actually holds must land it on
      // the repaired text; edits keyed to the staged text instead would splice.
      const edits = (recorded[0].edit.documentChanges![0] as { edits: TextEdit[] }).edits;
      const heldByClient = TextDocument.create(uri.toString(), 'domain', 1, ON_DISK);
      expect(TextDocument.applyEdits(heldByClient, edits)).toBe(repaired);
   });
});
