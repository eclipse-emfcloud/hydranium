/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { Disposable } from '@hydranium/protocol';
import type { AstNode, ValidationAcceptor, ValidationChecks } from '@hydranium/langium';
import { nameSeparatorCheck, NameSeparatorCheckContribution } from '../../../src/langium/naming/name-separator-validation.js';
import { DefaultNameProvider, type NameProvider, type NameProviderOptions } from '../../../src/langium/naming/name-provider.js';
import type { ServerLanguageServices } from '../../../src/langium/language-module.js';
import type { ValidationCheckRegistry } from '../../../src/langium/validation/validation-contribution.js';
import { makeFakeAstNode } from '../../../src/testing/index.js';

type AnyNode = AstNode & Record<string, unknown>;

function makeNameProvider(options: NameProviderOptions = {}): DefaultNameProvider {
   const services = {
      shared: {
         workspace: {
            ProjectManager: { getProject: () => undefined },
            DocumentBuilder: { onUpdate: () => Disposable.EMPTY }
         }
      }
   } as unknown as ServerLanguageServices;
   return new DefaultNameProvider(services, options);
}

interface CapturedDiagnostic {
   severity: string;
   message: string;
   node?: AstNode;
}

function makeAcceptor(): { accept: ValidationAcceptor; diagnostics: CapturedDiagnostic[] } {
   const diagnostics: CapturedDiagnostic[] = [];
   const accept: ValidationAcceptor = (severity, message, info) => {
      diagnostics.push({ severity, message, node: (info as { node?: AstNode } | undefined)?.node });
   };
   return { accept, diagnostics };
}

describe('nameSeparatorCheck', () => {
   it('flags a name containing the default `.` separator', () => {
      const check = nameSeparatorCheck(makeNameProvider());
      const { accept, diagnostics } = makeAcceptor();
      const node = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'foo.bar' });
      check(node, accept);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].severity).toBe('error');
      expect(diagnostics[0].message).toMatch(/foo\.bar/);
      expect(diagnostics[0].message).toMatch(/name separator '\.'/);
      // The diagnostic must be anchored to the offending node (the `{ node }` info object).
      expect(diagnostics[0].node).toBe(node);
   });

   it('does not return early for an empty name when the separator is also empty', () => {
      // Drives the guard `typeof ownName !== 'string' || ownName.length === 0`: with an
      // empty separator, `''.includes('')` is true — so if the early return were skipped
      // a (spurious) diagnostic would fire. The guard must suppress it.
      const check = nameSeparatorCheck(makeNameProvider({ nameSeparator: '' }));
      const { accept, diagnostics } = makeAcceptor();
      check(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: '' }), accept);
      expect(diagnostics).toHaveLength(0);
   });

   it('does not flag a name without the separator', () => {
      const check = nameSeparatorCheck(makeNameProvider());
      const { accept, diagnostics } = makeAcceptor();
      check(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'foo_bar' }), accept);
      expect(diagnostics).toHaveLength(0);
   });

   it('skips nodes that do not carry any name-bearing property', () => {
      const check = nameSeparatorCheck(makeNameProvider());
      const { accept, diagnostics } = makeAcceptor();
      check(makeFakeAstNode<AnyNode>({ $type: 'Anonymous' }), accept);
      expect(diagnostics).toHaveLength(0);
   });

   it('respects a configured separator: `::` flags `foo::bar` but accepts `foo.bar`', () => {
      const check = nameSeparatorCheck(makeNameProvider({ nameSeparator: '::' }));
      const flagged = makeAcceptor();
      check(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'foo::bar' }), flagged.accept);
      expect(flagged.diagnostics).toHaveLength(1);
      expect(flagged.diagnostics[0].message).toMatch(/foo::bar/);
      expect(flagged.diagnostics[0].message).toMatch(/name separator '::'/);

      const accepted = makeAcceptor();
      check(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'foo.bar' }), accepted.accept);
      // `.` is no longer the separator under this configuration, so it passes.
      expect(accepted.diagnostics).toHaveLength(0);
   });

   it('reads the separator polymorphically — works against any NameProvider implementation', () => {
      // The rule MUST take its separator from `nameProvider.nameSeparator`, not from a
      // hard-coded fallback. A minimal NameProvider stub that reports a non-default
      // separator must drive the check accordingly.
      const stubProvider = {
         nameSeparator: '/',
         getOwnName: (node: AstNode) => (node as AnyNode).name as string | undefined,
         getDocumentQualifiedName: () => undefined,
         getProjectQualifiedName: () => undefined,
         getProjectReferenceName: () => undefined,
         findNextName: () => '',
         getName: (node: AstNode) => (node as AnyNode).name as string | undefined,
         getNameNode: () => undefined
      };
      // The rule only reads `nameSeparator` and `getOwnName`; the remaining
      // NameProvider members are out of scope for this fixture, so the partial
      // stub is widened rather than stubbed member-by-member.
      const check = nameSeparatorCheck(stubProvider as unknown as NameProvider);
      const { accept, diagnostics } = makeAcceptor();
      check(makeFakeAstNode<AnyNode>({ $type: 'Resource', name: 'a/b/c' }), accept);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].message).toMatch(/name separator '\/'/);
   });

   it('skips empty-string names — no value to flag', () => {
      const check = nameSeparatorCheck(makeNameProvider());
      const { accept, diagnostics } = makeAcceptor();
      check(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: '' }), accept);
      expect(diagnostics).toHaveLength(0);
   });
});

describe('NameSeparatorCheckContribution', () => {
   it('registers an AstNode-keyed check via the framework ValidationCheckRegistry', () => {
      const registerCalls: Array<ValidationChecks<unknown>> = [];
      const services = {
         references: { NameProvider: makeNameProvider() }
      } as unknown as ServerLanguageServices;
      const contribution = new NameSeparatorCheckContribution(services);
      const registry: ValidationCheckRegistry = {
         register(checks) {
            registerCalls.push(checks);
         }
      };

      contribution.registerValidationChecks(registry);

      expect(registerCalls).toHaveLength(1);
      expect(registerCalls[0]).toHaveProperty('AstNode');
      expect(typeof (registerCalls[0] as { AstNode?: unknown }).AstNode).toBe('function');

      // The registered check must be wired to the NameProvider captured in the
      // constructor: invoking it flags a name carrying the separator. An empty
      // constructor body (no `this.nameProvider`) makes the check throw / not fire.
      const registeredCheck = (registerCalls[0] as { AstNode: (node: AstNode, accept: ValidationAcceptor) => void }).AstNode;
      const { accept, diagnostics } = makeAcceptor();
      registeredCheck(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'foo.bar' }), accept);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].message).toMatch(/foo\.bar/);
   });
});
