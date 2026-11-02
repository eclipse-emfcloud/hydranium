/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DefaultResourceProvider, type Resource } from '@theia/core/lib/common/resource';
import type URI from '@theia/core/lib/common/uri';
import { injectable, type interfaces } from '@theia/core/shared/inversify';

/**
 * Defaults content-only resources to read-only, regardless of their scheme.
 * Theia's extension content provider supplies neither saveContents nor a
 * readOnly policy, so its editor otherwise accepts edits it cannot save.
 * An explicit policy remains authoritative, including a getter whose value
 * changes later. A resource with saveContents stays writable unless its own
 * policy says otherwise, as file and untitled resources require.
 * The provider's cache and refresh events retain the original resource, so
 * mark that same instance rather than copying it for the editor.
 */
@injectable()
export class ReadOnlyContentResourceProvider extends DefaultResourceProvider {
   override async get(uri: URI): Promise<Resource> {
      const resource = await super.get(uri);
      if (!('readOnly' in resource) && !resource.saveContents) {
         Object.defineProperty(resource, 'readOnly', { value: true, configurable: true });
      }
      return resource;
   }
}

/** Bind before an editor resolves a content-only resource. */
export function bindReadOnlyContentResources(rebind: interfaces.Rebind): void {
   rebind(DefaultResourceProvider).to(ReadOnlyContentResourceProvider).inSingletonScope();
}
