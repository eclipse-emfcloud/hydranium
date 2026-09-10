/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `HydraniumLangiumDocuments` against three real grammars, booted as a server
 * rather than stubbed, so the reporting a caller actually sees is what is
 * asserted.
 *
 * The example binds nothing for this: the framework binds the class.
 */

import { chmodSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { URI } from '@hydranium/langium';
import { afterEach, describe, expect, it } from 'vitest';
import { HydraniumLangiumDocuments } from '@hydranium/core';
import { makeScratchWorkspaceHarness, makeServices, type ScratchOrderFlowHarness } from './order-flow-harness.js';

/** A URI that routes to a language but names no file, so nothing can be loaded. */
function absentUri(extension: string): URI {
   return URI.file(`/nowhere/absent.${extension}`);
}

describe('LangiumDocuments over three real grammars', () => {
   it('is the framework default, so a server gets it without binding anything', () => {
      const { shared } = makeServices();
      expect(shared.workspace.LangiumDocuments).toBeInstanceOf(HydraniumLangiumDocuments);
   });

   it('rejects for a file that is not there, whichever grammar claims the extension', async () => {
      const { shared } = makeServices();

      for (const extension of ['domain', 'process', 'layout']) {
         // An empty model would validate clean and read as a real, empty file.
         await expect(shared.workspace.LangiumDocuments.getOrCreateDocument(absentUri(extension))).rejects.toThrow();
      }
   });

   it('builds a correctly typed stand-in per grammar when asked directly', () => {
      const { shared } = makeServices();
      const documents = shared.workspace.LangiumDocuments;

      // What only a real multi-grammar server shows: the stand-in follows the
      // grammar the URI routes to, with no per-grammar code in the adopter.
      expect(documents.createEmptyDocument(absentUri('domain')).parseResult.value.$type).toBe('DomainModel');
      expect(documents.createEmptyDocument(absentUri('process')).parseResult.value.$type).toBe('ProcessModel');
      expect(documents.createEmptyDocument(absentUri('layout')).parseResult.value.$type).toBe('LayoutModel');
   });

   it('initialises containment lists, which a hand-built root would leave undefined', () => {
      const { shared } = makeServices();

      const root = shared.workspace.LangiumDocuments.createEmptyDocument(absentUri('domain')).parseResult.value as {
         declarations?: unknown;
      };

      expect(root.declarations).toEqual([]);
   });

   it('registers nothing for a URI it could not load', async () => {
      const { shared } = makeServices();
      const uri = absentUri('domain');

      await expect(shared.workspace.LangiumDocuments.getOrCreateDocument(uri)).rejects.toThrow();
      expect(shared.workspace.LangiumDocuments.hasDocument(uri)).toBe(false);
   });
});

describe('LangiumDocuments failure reporting, through a real server', () => {
   let scratch: ScratchOrderFlowHarness | undefined;

   afterEach(() => {
      scratch?.workspace.dispose();
      scratch = undefined;
   });

   it('carries the reason a present file could not be read', async () => {
      scratch = await makeScratchWorkspaceHarness();
      const unreadable = path.join(scratch.workspace.root, 'unreadable.domain');
      writeFileSync(unreadable, 'entity Order {}');
      chmodSync(unreadable, 0o000);

      // A miss and an unreadable file both reject, so the reason is the only
      // thing that tells them apart.
      await expect(scratch.harness.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(unreadable))).rejects.toThrow(
         /EACCES|permission/i
      );

      chmodSync(unreadable, 0o600);
   });
});
