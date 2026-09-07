/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { URI } from '@hydranium/langium';
import type { WritableFileSystemProvider } from '../documents/ast-document-manager.js';
import type { StubSelfSaveRegistry } from './stub-self-save-registry.js';

/**
 * Stub for {@link WritableFileSystemProvider}. Records `writeFile` calls so
 * tests can assert on the save path; reads return empty strings / empty
 * directory listings (the framework's read paths don't run against this
 * stub in the tests exercised today).
 *
 * When constructed with a {@link StubSelfSaveRegistry}, `writeFile` notifies
 * the registry with the current wall-clock as the mtime — standing in for
 * `DefaultFileSystemProvider.writeFile`, which registers the written file's
 * real mtime so the watcher echo for the server's own write is suppressed.
 *
 * # Stub-vs-real surface
 *
 * Picks only the framework-relevant methods from {@link WritableFileSystemProvider}
 * (`readFile`, `readDirectory`, `writeFile`); the compiler enforces those
 * signatures stay aligned with the real interface. Langium's wider
 * `FileSystemProvider` surface (`stat`, `statSync`, `exists`, `existsSync`,
 * etc.) is deliberately not picked — tests that need it should construct
 * the real `DefaultFileSystemProvider` instead. Binding the stub at
 * `services.workspace.FileSystemProvider` therefore needs a narrowing cast at
 * the binding site; casting the object literal itself would hide drift on the
 * picked methods too.
 */
export interface StubWritableFileSystem extends Pick<WritableFileSystemProvider, 'readFile' | 'readDirectory' | 'writeFile'> {
   readonly writes: ReadonlyArray<{ uri: string; content: string }>;
   reset(): void;
}

export function makeStubWritableFileSystem(selfSaveRegistry?: StubSelfSaveRegistry): StubWritableFileSystem {
   const writes: { uri: string; content: string }[] = [];
   return {
      get writes() {
         return writes;
      },
      readFile: async () => '',
      readDirectory: async () => [],
      async writeFile(uri: URI, content: string) {
         writes.push({ uri: uri.toString(), content });
         selfSaveRegistry?.register(uri.fsPath, Date.now());
      },
      reset() {
         writes.length = 0;
      }
   };
}
