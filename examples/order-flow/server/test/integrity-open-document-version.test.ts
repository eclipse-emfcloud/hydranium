/********************************************************************************
 * Copyright (c) 2026 CrossBreeze.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * How far an integrity repair of an OPEN document moves the store's version:
 * exactly one step, authored by the integrity id.
 *
 * The repair is a content change, so it is a version of its own. The
 * re-versioning `resyncDocument` runs after a repair serves a document no
 * client holds open, whose re-parse renumbers it from a factory default. An
 * open document is the opposite case: the factory hands back the store's OWN
 * text-document instance, and applying that re-versioning to it restores the
 * number captured before the repair, rolling the store back under the repair.
 *
 * The real store is required. The guard rests on `reconcileExternalContent`
 * answering `undefined` for anything currently synced, and the framework's own
 * double answers `undefined` unconditionally, so a stub cannot tell the two
 * cases apart.
 */

import { INTEGRITY_CLIENT_ID } from '@hydranium/core';
import { DocumentState, URI } from '@hydranium/langium';
import { afterEach, describe, expect, it } from 'vitest';
import { isDomainModel } from '../src/language-server/ast.js';
import { makeScratchWorkspaceHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const FILE = 'open-repair.domain';

/** On disk at boot, and repaired by nothing. */
const CLEAN = `entity Solo {
   a : string
}
`;
/** Typed by the client while the document is OPEN. The duplicate is the repair trigger. */
const WITH_DUPLICATE = `entity Twin {
   a : string
}

entity Twin {
   b : string
}
`;

let scratch: ScratchOrderFlowHarness | undefined;

/**
 * Poll until `predicate` holds. A `didChange` is debounced before it reaches the
 * builder, so `waitUntil(Validated)` returns against the PREVIOUS build and
 * proves nothing about this edit.
 */
async function until(predicate: () => boolean, what: string): Promise<void> {
   for (let attempt = 0; attempt < 200; attempt++) {
      if (predicate()) {
         return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
   }
   throw new Error(`Timed out waiting for ${what}`);
}

/** The declaration names currently on the document's AST, re-read each call. */
function declarationNames(harness: ScratchOrderFlowHarness['harness'], uri: URI): string[] {
   const root = harness.shared.workspace.LangiumDocuments.getDocument(uri)?.parseResult.value;
   return root !== undefined && isDomainModel(root) ? root.declarations.map(declaration => declaration.name) : [];
}

afterEach(() => {
   scratch?.workspace.dispose();
   scratch = undefined;
});

describe('an integrity repair of an open document', () => {
   it('steps the version the store assigned once, under the integrity id', async () => {
      scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, CLEAN));
      const { harness, workspace } = scratch;
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
         contentChanges: [{ text: WITH_DUPLICATE }]
      });
      // The store assigns the version synchronously on the notification above,
      // so this is what it decided for the edit — captured BEFORE integrity has
      // had a chance to move it.
      const versionAfterTheEdit = textDocuments.version(uriString);

      // Driven directly, because nothing routes the store's change event to the
      // builder without an LSP connection — Langium wires that in
      // `startLanguageServer`, not in the update handler's constructor. The
      // build re-parses from the STORE's text, which is what makes this the
      // open-document path.
      await builder.update([uri], []);
      await builder.waitUntil(DocumentState.Validated, uri);

      // Waiting for the repair IS the vacuity guard: a timeout here means the
      // edit never reached the build, and the version assertions below would
      // otherwise pass against a document nothing had repaired.
      await until(() => declarationNames(harness, uri).includes('Twin__1'), 'the duplicate to be repaired');

      const document = harness.shared.workspace.LangiumDocuments.getDocument(uri)!;

      // The repair is the one version after the edit. Read back through the
      // store AND off the document, because they are the same instance on this
      // path and a roll-back through either spelling is the failure.
      expect(textDocuments.version(uriString)).toBe(versionAfterTheEdit + 1);
      expect(document.textDocument.version).toBe(versionAfterTheEdit + 1);
      expect(textDocuments.getAuthor(uriString, versionAfterTheEdit + 1)).toBe(INTEGRITY_CLIENT_ID);
      expect(textDocuments.isOpenInLanguageClient(uriString)).toBe(true);
   });
});
