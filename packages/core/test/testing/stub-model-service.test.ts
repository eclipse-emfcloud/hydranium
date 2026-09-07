/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `makeStubModelService` measured against the `ModelService` it doubles.
 *
 * There is nothing to conformance-test: `StubModelService` is a type ALIAS for
 * `ModelService` and the factory returns a subclass, so every member is the
 * real one and a signature change fails `npm run build`. What no compiler sees
 * is the three claims the factory's doc comment makes:
 *
 * - The framework default `serialize` path "would fail" on a stub services
 *   tree, which is the entire reason the callback exists. Asserted on the REAL
 *   class, because if `makeTestServices` ever bound a serializer by default the
 *   justification would be stale and nothing else would notice.
 * - The callback REPLACES that path rather than supplementing it — so a stub
 *   standing on a tree that does have a serializer still answers from the
 *   callback, and a test asserting serialized text is asserting its own
 *   fixture, not the framework's serializer routing.
 * - `options` are "forwarded verbatim", so an option-gated code path is
 *   reachable without hand-rolling a subclass. Compared field-by-field against
 *   a real `ModelService` constructed with the same options.
 *
 * `serialize` is `protected`, so the reads below go through a structural cast —
 * the same shape `make-test-services.test.ts` uses for the bundled default.
 */

import { describe, expect, it } from 'vitest';
import type { AstNode } from '@hydranium/langium';
import type { TransferDiagnostic } from '@hydranium/protocol';
import { ModelService, type ModelServiceOptions } from '../../src/langium/model-service/model-service.js';
import type { ServerSharedServices } from '../../src/langium/module.js';
import { makeStubModelService, makeTestServices, type StubLanguageDescriptor } from '../../src/testing/index.js';

interface FakeRoot extends AstNode {
   readonly $type: 'FakeRoot';
   readonly name: string;
}

const URI_A = 'file:///a.fake';
const ROOT: FakeRoot = { $type: 'FakeRoot', name: 'seeded' } as FakeRoot;

/** A language whose `Serializer` is bound, so the framework default path can succeed. */
const WITH_SERIALIZER: readonly StubLanguageDescriptor[] = [
   {
      languageId: 'fake',
      fileExtensions: ['.fake'],
      services: {
         serializer: {
            Serializer: {
               serializeTransfer: (root: FakeRoot): string => `framework:${root.name}`
            }
         }
      }
   }
];

/** Read the `protected serialize` hook off a model service. */
function serializerOf(service: ModelService<FakeRoot, TransferDiagnostic, FakeRoot>): (uri: string, root: FakeRoot) => unknown {
   const hook = service as unknown as { serialize(uri: string, root: FakeRoot): unknown };
   return hook.serialize.bind(hook);
}

/** Read the two option-derived fields off a model service. */
function optionsOf(service: ModelService<FakeRoot, TransferDiagnostic, FakeRoot>): {
   serializeBuilds: boolean;
   slowUpdateWarnMs: number | undefined;
} {
   const fields = service as unknown as {
      serializeBuilds: { value: boolean };
      slowUpdateWarn?: { value: number };
   };
   return { serializeBuilds: fields.serializeBuilds.value, slowUpdateWarnMs: fields.slowUpdateWarn?.value };
}

function bundleWith(languages?: readonly StubLanguageDescriptor[]): ServerSharedServices {
   return makeTestServices<FakeRoot, TransferDiagnostic, FakeRoot>(languages ? { languages: [...languages] } : {}).services;
}

describe('makeStubModelService — the serialize seam, against the real ModelService', () => {
   it('is the real ModelService with one hook replaced, not a look-alike', () => {
      const stub = makeStubModelService<FakeRoot, TransferDiagnostic, FakeRoot>(bundleWith(), () => 'stub-text');

      expect(stub).toBeInstanceOf(ModelService);
   });

   it('answers from the callback where the real default path cannot run at all', () => {
      const services = bundleWith();
      const real = new ModelService<FakeRoot, TransferDiagnostic, FakeRoot>(services);
      const stub = makeStubModelService<FakeRoot, TransferDiagnostic, FakeRoot>(services, (_uri, root) => `stub:${root.name}`);

      // The claim being verified: on a stub tree the framework path FAILS. If
      // `makeTestServices` ever bound a ServiceRegistry by default this throws
      // nothing and the callback stops being necessary.
      expect(() => serializerOf(real)(URI_A, ROOT)).toThrow();
      expect(serializerOf(stub)(URI_A, ROOT)).toBe('stub:seeded');
   });

   it('replaces the framework serializer rather than supplementing it', () => {
      const services = bundleWith(WITH_SERIALIZER);
      const real = new ModelService<FakeRoot, TransferDiagnostic, FakeRoot>(services);
      const stub = makeStubModelService<FakeRoot, TransferDiagnostic, FakeRoot>(services, (_uri, root) => `stub:${root.name}`);

      // Anchor on the real side: the bound serializer IS reachable through the
      // registry, so the stub's answer below is a substitution and not the
      // absence of an alternative.
      expect(serializerOf(real)(URI_A, ROOT)).toBe('framework:seeded');
      expect(serializerOf(stub)(URI_A, ROOT)).toBe('stub:seeded');
   });

   it('passes the URI it was asked about through to the callback', () => {
      const seen: string[] = [];
      const stub = makeStubModelService<FakeRoot, TransferDiagnostic, FakeRoot>(bundleWith(), uri => {
         seen.push(uri);
         return 'stub-text';
      });

      serializerOf(stub)(URI_A, ROOT);

      expect(seen).toEqual([URI_A]);
   });
});

describe('makeStubModelService — option forwarding, against the real ModelService', () => {
   it('derives the same option-gated state as a real ModelService given the same options', () => {
      const services = bundleWith();
      const cases: readonly (ModelServiceOptions | undefined)[] = [
         undefined,
         {},
         { serializeBuilds: false },
         { serializeBuilds: true, slowUpdateWarnMs: 42 },
         { slowUpdateWarnMs: 0 }
      ];

      for (const options of cases) {
         const real = new ModelService<FakeRoot, TransferDiagnostic, FakeRoot>(services, options);
         const stub = makeStubModelService<FakeRoot, TransferDiagnostic, FakeRoot>(services, () => 'stub-text', options);
         expect(optionsOf(stub)).toEqual(optionsOf(real));
      }

      // Two services that both derived nothing would agree above, so pin the
      // documented defaults and one non-default on the real side.
      expect(optionsOf(new ModelService<FakeRoot, TransferDiagnostic, FakeRoot>(services))).toEqual({
         serializeBuilds: true,
         slowUpdateWarnMs: undefined
      });
      expect(optionsOf(new ModelService<FakeRoot, TransferDiagnostic, FakeRoot>(services, { serializeBuilds: false }))).toEqual({
         serializeBuilds: false,
         slowUpdateWarnMs: undefined
      });
      expect(optionsOf(new ModelService<FakeRoot, TransferDiagnostic, FakeRoot>(services, { slowUpdateWarnMs: 0 })).slowUpdateWarnMs).toBe(
         0
      );
   });

   it('resolves ready on a tree that binds no WorkspaceManager, like the real service', async () => {
      const services = bundleWith();
      const real = new ModelService<FakeRoot, TransferDiagnostic, FakeRoot>(services);
      const stub = makeStubModelService<FakeRoot, TransferDiagnostic, FakeRoot>(services, () => 'stub-text');

      // A hang, not a rejection, is the failure this guards: both sides must
      // settle, so the assertion is that the race resolves rather than which.
      await expect(Promise.all([real.ready, stub.ready])).resolves.toEqual([undefined, undefined]);
   });
});
