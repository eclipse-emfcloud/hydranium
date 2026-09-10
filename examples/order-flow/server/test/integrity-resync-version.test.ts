/********************************************************************************
 * Copyright (c) 2026 CrossBreeze.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Whether a document still reports the store's version after an integrity rule
 * repaired it while no client held it open — and whether that version is the one
 * the next open will assign, which takes the sequence describing the REPAIRED
 * content rather than whatever was on disk when the store last reconciled. The
 * two come apart: restoring the pre-re-parse number satisfies the first and
 * leaves the second wrong, at which point the next open steps the version again
 * and every `baseVersion` taken from this build is stale before it is used.
 *
 * Every layer has to be the real one for the question to exist: the renumbering
 * this pins is Langium's document factory re-reading a closed document into a
 * text document that counts from zero, so a stubbed builder or text store cannot
 * produce it — and the value being discarded is one the store's own Parsed-phase
 * reconciliation put there, which needs a real version sequence behind it.
 *
 * Both integrity phases are covered, because `resyncDocument` reconciles the
 * document differently at each and only one of them has an example rule. The
 * Linked case registers its own: `reparseAndRelink` re-fires the Parsed
 * notification, so the store's reconciliation DOES run there — against the text
 * on disk, which is the pre-repair text, which is exactly why the branch cannot
 * rely on it.
 *
 * The Parsed case runs on the DEFAULT sync mode, the path an adopter gets by
 * binding the integrity tier at all. The Linked case must run on `'editor'`:
 * `'silent'` puts the repair on disk before the re-parse re-reads it, so the
 * version is already right there whatever this branch does, and a default-mode
 * Linked case is unfalsifiable — which is what made the branch look covered
 * when it was not. Only staging leaves disk holding the pre-repair text.
 */

import { DefaultIntegrityService, IntegrityPhase, type IntegrityRule } from '@hydranium/core';
import { type AstNode, DocumentState, URI } from '@hydranium/langium';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { isDomainModel } from '../src/language-server/ast.js';
import { makeScratchWorkspaceHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const FILE = 'resync-version.domain';

/** On disk at boot. No duplicate, so the initial build repairs nothing. */
const CLEAN = `entity Solo {
   a : string
}
`;
/** What the client edits it to while open, stepping the shared version. */
const EDITED = `entity Solo {
   a : string
   b : string
}
`;
/** Written to disk while CLOSED. `UniqueDeclarationNamesRule` suffixes the second. */
const DUPLICATES = `entity Dup {
   a : string
}

entity Dup {
   b : string
}
`;
/** Written to disk while CLOSED for the Linked case; the rule below renames it. */
const MARKED = `entity Marked {
   a : string
}
`;

let scratch: ScratchOrderFlowHarness | undefined;

afterEach(() => {
   scratch?.workspace.dispose();
   scratch = undefined;
});

describe('an integrity repair of a closed document lands on the store version sequence', () => {
   /**
    * Open / edit / close so the URI carries a persisted sequence above zero and
    * leaves the store, then land `diskWhileClosed` on it and rebuild. `prepare`
    * runs before the first build, which is the only point a Linked-phase rule can
    * be registered in time.
    */
   async function repairWhileClosed(
      diskWhileClosed: string,
      options: { syncMode?: 'editor' | 'silent'; prepare?: (harness: ScratchOrderFlowHarness['harness']) => void } = {}
   ): Promise<void> {
      const { syncMode, prepare } = options;
      scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, CLEAN), {
         extraLanguageModules: syncMode
            ? [{ integrity: { IntegrityService: services => new DefaultIntegrityService(services, { syncMode }) } }]
            : []
      });
      const { harness, workspace } = scratch;
      const uri = URI.file(workspace.resolve(FILE));
      const uriString = uri.toString();
      const textDocuments = harness.shared.workspace.TextDocuments;
      const builder = harness.shared.workspace.DocumentBuilder;
      prepare?.(harness);

      textDocuments.notifyDidOpenTextDocument({
         textDocument: { uri: uriString, languageId: 'domain', version: 1, text: CLEAN }
      });
      await builder.waitUntil(DocumentState.Validated, uri);
      textDocuments.notifyDidChangeTextDocument({
         textDocument: { uri: uriString, version: 2 },
         contentChanges: [{ text: EDITED }]
      });
      await builder.waitUntil(DocumentState.Validated, uri);
      textDocuments.notifyDidCloseTextDocument({ textDocument: { uri: uriString } });

      // A content transition while closed — the shape the store's Parsed-phase
      // reconciliation exists for. Driven directly rather than through a watcher.
      writeFileSync(workspace.resolve(FILE), diskWhileClosed, 'utf8');
      await builder.update([uri], []);
      await builder.waitUntil(DocumentState.Validated, uri);
   }

   /** The two assertions, run against whatever the repair left behind. */
   async function expectVersionLandsOnTheSequence(repairedName: string): Promise<void> {
      const { harness, workspace } = scratch!;
      const uri = URI.file(workspace.resolve(FILE));
      const uriString = uri.toString();
      const textDocuments = harness.shared.workspace.TextDocuments;
      const document = harness.shared.workspace.LangiumDocuments.getDocument(uri)!;
      const root = document.parseResult.value;
      if (!isDomainModel(root)) {
         throw new Error(`Expected a DomainModel root, got ${root.$type}`);
      }

      // Without this the version assertions pass vacuously: no repair means no
      // resync, and no resync is the case that was never broken.
      expect(root.declarations.map(declaration => declaration.name)).toContain(repairedName);

      // The sequence is what every downstream envelope is compared against, so the
      // document has to agree with it. Pinned as agreement rather than as a
      // literal, and guarded against both sides being zero.
      const sequenceVersion = textDocuments.version(uriString);
      expect(sequenceVersion).toBeGreaterThan(0);
      expect(document.textDocument.version).toBe(sequenceVersion);

      // And the sequence has to describe the REPAIRED text, not the text that was
      // on disk when the store last reconciled. Otherwise the next open hashes
      // the repair, finds a mismatch, steps the version again, and every
      // `baseVersion` taken from this build is stale before anyone can use it.
      // Reconciling is idempotent when the content already matches, so the same
      // version coming back IS the assertion.
      const repaired = await harness.domain.serializer.Serializer.serializeAst(root);
      expect(textDocuments.reconcileExternalContent(uriString, repaired)).toBe(sequenceVersion);
   }

   it('reports the version the next open will assign, for a Parsed-phase repair', async () => {
      await repairWhileClosed(DUPLICATES);
      await expectVersionLandsOnTheSequence('Dup__1');
   });

   /** The Linked-phase rule no example otherwise has. */
   const linkedRenameRule: IntegrityRule = {
      id: 'test-linked-rename',
      nodeType: 'Entity',
      phase: IntegrityPhase.Linked,
      enforce: (node: AstNode) => {
         const named = node as AstNode & { name?: string };
         if (named.name !== 'Marked') {
            return false;
         }
         named.name = 'Marked__linked';
         return true;
      }
   };

   it('reports the version the next open will assign, for a Linked-phase repair', async () => {
      await repairWhileClosed(MARKED, {
         syncMode: 'editor',
         prepare: harness => harness.domain.integrity.IntegrityService.register(linkedRenameRule)
      });
      await expectVersionLandsOnTheSequence('Marked__linked');
   });
});
