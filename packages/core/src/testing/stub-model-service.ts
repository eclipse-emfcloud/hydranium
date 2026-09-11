/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { TransferDiagnostic, TransferElement } from '@hydranium/protocol';
import type { AstNode } from '@hydranium/langium';
import { DefaultModelService, type ModelService, type ModelServiceOptions } from '../langium/model-service/model-service.js';
import type { ServerSharedServices } from '../langium/module.js';

/**
 * Implementation detail of {@link makeStubModelService}. A {@link ModelService}
 * subclass that takes `serialize` as a constructor callback — the test stub
 * services tree has no `ServiceRegistry`, so the framework default `serialize`
 * path would fail. Construct it through the factory; the {@link StubModelService}
 * type alias is the public type name.
 */
class StubModelServiceImpl<
   TAst extends AstNode,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TTransfer extends TransferElement = TransferElement
> extends DefaultModelService<TAst, TDiagnostic, TTransfer> {
   constructor(
      services: ServerSharedServices,
      protected readonly serializeFn: (uri: string, root: TTransfer) => string,
      options?: ModelServiceOptions
   ) {
      super(services, options);
   }

   protected override serialize(uri: string, root: TTransfer): string {
      return this.serializeFn(uri, root);
   }
}

/** The type of the model-service test double produced by {@link makeStubModelService}. */
export type StubModelService<
   TAst extends AstNode,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TTransfer extends TransferElement = TransferElement
> = ModelService<TAst, TDiagnostic, TTransfer>;

/**
 * Build a {@link StubModelService} — a {@link ModelService} test double that
 * takes `serialize` as a constructor callback. The stub services tree has no
 * `ServiceRegistry`, so the framework default `serialize` path would fail; the
 * callback supplies a grammar-free serializer instead. The bundle assembled by
 * `makeTestServices` wires this stub automatically.
 *
 * `options` are the framework {@link ModelServiceOptions}, forwarded verbatim, so
 * a test can exercise an option-gated code path (`serializeBuilds`, the slow-warn
 * threshold) without hand-rolling a subclass just to reach the constructor.
 *
 * Adopters that need richer override behaviour — the framework's own extension
 * surface is {@link ModelService.rewriteModel} alongside `serialize` — should
 * subclass {@link ModelService} directly instead.
 */
export function makeStubModelService<
   TAst extends AstNode,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TTransfer extends TransferElement = TransferElement
>(
   services: ServerSharedServices,
   serialize: (uri: string, root: TTransfer) => string,
   options?: ModelServiceOptions
): StubModelService<TAst, TDiagnostic, TTransfer> {
   return new StubModelServiceImpl<TAst, TDiagnostic, TTransfer>(services, serialize, options);
}
