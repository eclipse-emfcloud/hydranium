/********************************************************************************
 * Copyright (c) 2026 CrossBreeze.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Whether an integrity repair of an OPEN document leaves the store's version
 * alone.
 *
 * The re-versioning `resyncDocument` performs after a repair exists for a
 * document no client holds open, whose re-parse renumbers it from a factory
 * default. An open document is the opposite case: the factory hands back the
 * store's OWN text-document instance, whose version the store assigns and which
 * this path must not move — a bump here would advance a counter every
 * `baseVersion` holder is gating on, mid-build, for a write nobody made.
 *
 * The real store is required. The guard rests on `reconcileExternalContent`
 * answering `undefined` for anything currently synced, and the framework's own
 * double answers `undefined` unconditionally, so a stub cannot tell the two
 * cases apart.
 */

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
   it('does not move the version the store assigned', async () => {
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

      // The edit is the last thing that assigned a version; the repair rode it
      // rather than minting one. Read back through the store AND off the
      // document, because they are the same instance on this path and a bump
      // through either spelling is the failure.
      expect(textDocuments.version(uriString)).toBe(versionAfterTheEdit);
      expect(document.textDocument.version).toBe(versionAfterTheEdit);
      expect(textDocuments.isOpenInLanguageClient(uriString)).toBe(true);
   });
});
