/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import type { ServerSharedServices } from '../../src/langium/module.js';
import type { ServerSharedServicesMinimal } from '../../src/langium/shared-services.js';

type Registry = ServerSharedServices['ServiceRegistry'];
type PublicRegistry = Omit<Pick<Registry, keyof Registry>, 'acceptSharedServices'>;

function acceptsIndependentRegistry(registry: PublicRegistry): void {
   const full: ServerSharedServices['ServiceRegistry'] = registry;
   const minimal: ServerSharedServicesMinimal['ServiceRegistry'] = registry;
   void full;
   void minimal;
}

describe('HydraniumServiceRegistry structural replacement', () => {
   it('accepts the public contract without implementation inheritance', () => {
      expect(acceptsIndependentRegistry).toBeTypeOf('function');
   });
});
