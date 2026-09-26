/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What `FileSystemProviderRegistry`'s host parameter keeps and refuses.
 *
 * The guarantees are type-level, so `typecheck:test` is what runs them — a
 * separate turbo task from `build`, which does not typecheck tests. Each
 * refusal is a `@ts-expect-error`, and an UNUSED one is itself an error, so a
 * clean compile proves every one of them fired.
 *
 * A module's slots are `DeepPartial`, which makes every host member optional,
 * so a bare factory would accept any host. The binding annotates its return
 * type, and that annotation is what the refusals below hold to.
 */

import { type DeepPartial, type Module } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { type ServerSharedServices, type WithServiceOverrides } from '../../../src/langium/module.js';
import {
   DefaultEmptyFileSystemProvider,
   DefaultFileSystemProviderRegistry,
   type FileSystemProviderRegistry
} from '../../../src/langium/workspace/file-system-provider.js';

/** An adopter's provider, with a member the base interface lacks. */
declare class DiskProvider extends DefaultEmptyFileSystemProvider {
   readonly root: string;
}

/** The adopter's services type, replacing the slot's declaration with one typed by its own host. */
type DiskServices = WithServiceOverrides<
   ServerSharedServices,
   { workspace: { FileSystemProvider: FileSystemProviderRegistry<DiskProvider> } }
>;

declare const services: DiskServices;
declare const disk: DiskProvider;

function typeAssertions(): void {
   // Accepted: the narrowed slot keeps the host's own members.
   const root: string = services.workspace.FileSystemProvider.host.root;
   void root;

   // Accepted: the narrowed slot still satisfies the framework's slot type.
   const framework: ServerSharedServices['workspace']['FileSystemProvider'] = services.workspace.FileSystemProvider;
   void framework;

   // Accepted: the binding that makes the narrowed slot true.
   const module: Module<DiskServices, DeepPartial<DiskServices>> = {
      workspace: {
         FileSystemProvider: (shared): FileSystemProviderRegistry<DiskProvider> =>
            new DefaultFileSystemProviderRegistry(shared, { host: disk })
      }
   };
   void module;

   const refusedBinding: Module<DiskServices, DeepPartial<DiskServices>> = {
      workspace: {
         FileSystemProvider: (shared): FileSystemProviderRegistry<DiskProvider> =>
            // @ts-expect-error the annotated binding refuses a plain host
            new DefaultFileSystemProviderRegistry(shared, { host: new DefaultEmptyFileSystemProvider(shared) })
      }
   };
   void refusedBinding;

   // @ts-expect-error the framework's default slot types its host at the
   // base interface, which has no `root`
   const unknownRoot: string = framework.host.root;
   void unknownRoot;

   // @ts-expect-error a registry whose host is a plain provider does not
   // stand in for one that promises the adopter's
   const refused: FileSystemProviderRegistry<DiskProvider> = new DefaultFileSystemProviderRegistry(services, {
      host: new DefaultEmptyFileSystemProvider(services)
   });
   void refused;
}

describe('FileSystemProviderRegistry host parameter', () => {
   it('compiles, which is the assertion', () => {
      expect(typeAssertions).toBeTypeOf('function');
   });
});
