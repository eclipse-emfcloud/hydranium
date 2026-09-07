/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { SelfSaveRegistry } from '../documents/self-save-registry.js';

/**
 * Stub for the framework's {@link SelfSaveRegistry}. Records `register` calls
 * so tests can assert that a save path correctly notified the registry.
 *
 * # Stub-vs-real surface
 *
 * The stub declares only the methods exercised by tests via
 * `Pick<SelfSaveRegistry, ...>` — TypeScript enforces that each picked
 * method's signature stays in lockstep with the real class. `matches`, the
 * only other member, is not claimed and so cannot be called through this
 * interface; a test that needs the TTL / mtime matching either picks it here
 * or uses the real class.
 */
export interface StubSelfSaveRegistry extends Pick<SelfSaveRegistry, 'register'> {
   readonly registerCalls: ReadonlyArray<{ fsPath: string; mtimeMs: number }>;
   reset(): void;
}

export function makeStubSelfSaveRegistry(): StubSelfSaveRegistry {
   const registerCalls: { fsPath: string; mtimeMs: number }[] = [];
   return {
      get registerCalls() {
         return registerCalls;
      },
      register(fsPath, mtimeMs) {
         registerCalls.push({ fsPath, mtimeMs });
      },
      reset() {
         registerCalls.length = 0;
      }
   };
}
