/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type LangiumDocument, URI } from '@hydranium/langium';
import { isVirtualUri, serveVirtualDocument, virtualUri } from '../../../src/langium/workspace/virtual-document.js';
import { type ServerSharedServicesMinimal } from '../../../src/langium/shared-services.js';
import { makeNoopSharedServices } from '../../../src/testing/index.js';

function servicesWith(docs: Record<string, string>): ServerSharedServicesMinimal {
   return makeNoopSharedServices({
      workspace: {
         LangiumDocuments: {
            getDocument(uri: URI): LangiumDocument | undefined {
               const text = docs[uri.toString()];
               return text === undefined ? undefined : ({ uri, textDocument: { getText: () => text } } as unknown as LangiumDocument);
            }
         }
      }
   });
}

describe('virtualUri', () => {
   it('builds a contributor-tagged URI with no segments', () => {
      const uri = virtualUri('stdlib');
      expect(uri.toString()).toBe('virtual:stdlib');
      expect(uri.scheme).toBe('virtual');
      expect(uri.path).toBe('stdlib');
   });

   it('appends segments after the contributor', () => {
      expect(virtualUri('stdlib', 'types', 'Any').toString()).toBe('virtual:stdlib/types/Any');
   });

   it('round-trips cleanly through URI.parse (no percent-encoding)', () => {
      const uri = virtualUri('contrib', 'a', 'b');
      expect(uri.toString()).not.toContain('%');
   });
});

describe('isVirtualUri', () => {
   it('returns true for URIs built by virtualUri', () => {
      expect(isVirtualUri(virtualUri('foo'))).toBe(true);
   });

   it('returns true for any URI with the virtual: scheme', () => {
      expect(isVirtualUri(URI.parse('virtual:bare'))).toBe(true);
   });

   it('returns false for file URIs', () => {
      expect(isVirtualUri(URI.parse('file:///a/b.test'))).toBe(false);
   });
});

describe('serveVirtualDocument', () => {
   it('returns the registered document text for a virtual URI', () => {
      const services = servicesWith({ 'virtual:builtin/Element': 'element Element' });
      expect(serveVirtualDocument(services, virtualUri('builtin', 'Element'))).toBe('element Element');
   });

   it('returns undefined for a non-virtual URI (delegate to the real backing)', () => {
      const services = servicesWith({ 'file:///a.a': 'x' });
      expect(serveVirtualDocument(services, URI.parse('file:///a.a'))).toBeUndefined();
   });

   it('returns undefined for a virtual URI with no registered document', () => {
      const services = servicesWith({});
      expect(serveVirtualDocument(services, virtualUri('builtin', 'Missing'))).toBeUndefined();
   });
});
