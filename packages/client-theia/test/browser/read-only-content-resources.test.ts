/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import type { Resource } from '@theia/core/lib/common/resource';
import URI from '@theia/core/lib/common/uri';
import { describe, expect, it } from 'vitest';
import { ReadOnlyContentResourceProvider } from '../../src/browser/read-only-content-resources';

describe('ReadOnlyContentResourceProvider', () => {
   it.each(['virtual', 'library', 'file'])('keeps content-only resources read-only with scheme %s', async scheme => {
      let content = 'first';
      const resource: Resource = {
         uri: new URI(`${scheme}:/a.one`),
         readContents: async () => content,
         dispose: () => undefined
      };
      const provider = new ReadOnlyContentResourceProvider({ getContributions: () => [{ resolve: () => resource }] });
      const resolved = await provider.get(resource.uri);
      expect(resolved).toBe(resource);
      expect(resolved.readOnly).toBe(true);
      content = 'refreshed';
      expect(await resolved.readContents()).toBe('refreshed');
   });

   it.each(['virtual', 'file', 'untitled'])('preserves writable resources with scheme %s', async scheme => {
      const resource: Resource = {
         uri: new URI(`${scheme}:/a.one`),
         readContents: async () => 'text',
         saveContents: async () => undefined,
         dispose: () => undefined
      };
      const provider = new ReadOnlyContentResourceProvider({ getContributions: () => [{ resolve: () => resource }] });
      expect(await provider.get(resource.uri)).toBe(resource);
      expect(resource.readOnly).toBeUndefined();
   });

   it('preserves an explicit read-only policy and its later changes', async () => {
      let readOnly: Resource['readOnly'];
      const resource: Resource = {
         uri: new URI('virtual:/a.one'),
         get readOnly() {
            return readOnly;
         },
         readContents: async () => 'text',
         dispose: () => undefined
      };
      const provider = new ReadOnlyContentResourceProvider({ getContributions: () => [{ resolve: () => resource }] });
      const resolved = await provider.get(resource.uri);
      expect(resolved.readOnly).toBeUndefined();
      readOnly = false;
      expect(resolved.readOnly).toBe(false);
      readOnly = { value: 'Provider-owned read-only message' };
      expect(resolved.readOnly).toBe(readOnly);
   });
});
