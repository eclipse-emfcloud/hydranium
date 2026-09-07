/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type interfaces } from '@theia/core/shared/inversify';

/** Builds the minimal slice of an Inversify Context needed by
 *  `getRequestParentName`: just the `currentRequest.parentRequest.bindings[0].implementationType.name`
 *  shape. Tests pass the desired parent class name (or undefined) and receive a
 *  cast context for the helper to walk. */
export function makeStubInversifyContext(parentClassName?: string): interfaces.Context {
   const parentRequest =
      parentClassName === undefined
         ? null
         : {
              bindings: [
                 {
                    implementationType: parentClassName === '' ? {} : { name: parentClassName }
                 }
              ]
           };
   return {
      currentRequest: {
         parentRequest
      }
   } as unknown as interfaces.Context;
}
