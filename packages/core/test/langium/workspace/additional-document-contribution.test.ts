/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, type LangiumDocument, URI } from '@hydranium/langium';
import {
   type AdditionalDocumentContribution,
   collectAdditionalDocuments
} from '../../../src/langium/workspace/additional-document-contribution.js';

function fakeDoc(uri: string): LangiumDocument<AstNode> {
   return { uri: URI.parse(uri) } as unknown as LangiumDocument<AstNode>;
}

describe('collectAdditionalDocuments', () => {
   it('collects the documents a contribution registers', async () => {
      const contribution: AdditionalDocumentContribution = {
         registerAdditionalDocuments: registry => {
            registry.register(fakeDoc('virtual:a'));
            registry.register(fakeDoc('virtual:b'));
         }
      };
      const collected: string[] = [];
      await collectAdditionalDocuments({ c: contribution }, [], doc => collected.push(doc.uri.toString()));
      expect(collected).toEqual(['virtual:a', 'virtual:b']);
   });

   it('collects from every contribution in the group', async () => {
      const a: AdditionalDocumentContribution = { registerAdditionalDocuments: r => r.register(fakeDoc('virtual:a')) };
      const b: AdditionalDocumentContribution = { registerAdditionalDocuments: r => r.register(fakeDoc('virtual:b')) };
      const collected: string[] = [];
      await collectAdditionalDocuments({ a, b }, [], doc => collected.push(doc.uri.toString()));
      expect(collected.sort()).toEqual(['virtual:a', 'virtual:b']);
   });

   it('awaits async contributions', async () => {
      const contribution: AdditionalDocumentContribution = {
         registerAdditionalDocuments: async registry => {
            await Promise.resolve();
            registry.register(fakeDoc('virtual:async'));
         }
      };
      const collected: string[] = [];
      await collectAdditionalDocuments({ c: contribution }, [], doc => collected.push(doc.uri.toString()));
      expect(collected).toEqual(['virtual:async']);
   });

   it('is a no-op for an empty group', async () => {
      const collected: string[] = [];
      await collectAdditionalDocuments({}, [], doc => collected.push(doc.uri.toString()));
      expect(collected).toEqual([]);
   });

   it('hands the workspace folders to the contribution', async () => {
      const folders = [{ name: 'ws', uri: 'file:///ws' }];
      let seenFolders: readonly { name: string; uri: string }[] | undefined;
      const contribution: AdditionalDocumentContribution = {
         registerAdditionalDocuments: registry => void (seenFolders = registry.folders)
      };
      await collectAdditionalDocuments({ c: contribution }, folders, () => undefined);
      expect(seenFolders).toEqual(folders);
   });
});
