/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What `AstDocument`'s diagnostic parameter admits and refuses.
 *
 * The guarantees are type-level, so `typecheck:test` is what runs them — a
 * separate turbo task from `build`, which does not typecheck tests. Each
 * refusal is a `@ts-expect-error`, and an UNUSED one is itself an error, so a
 * clean compile proves every one of them fired.
 *
 * Dropping the constraint reddens this file and nothing else in the tree: every
 * other suite parameterises the envelope with a shape that satisfies it either
 * way, so all of them stay green under the change that removes the guarantee.
 */

import { describe, expect, it } from 'vitest';
import { type AstNode } from '@hydranium/langium';
import { type TransferDiagnostic } from '@hydranium/protocol';
import { Diagnostic } from 'vscode-languageserver-types';
import { AstDocument } from '../../src/documents/ast-document-manager.js';
import { type AstDiagnostic } from '../../src/langium/validation/document-validator.js';

interface Root extends AstNode {
   readonly $type: 'TypeOne';
}

/** An adopter's own diagnostic: the AST-layer shape plus whatever their validator attaches. */
interface RichDiagnostic extends AstDiagnostic {
   ruleId: string;
}

declare const root: Root;
declare const rich: RichDiagnostic[];
declare const diagnostic: AstDiagnostic;
declare const wireDiagnostic: TransferDiagnostic;

function typeAssertions(): void {
   // Accepted: the default, which is what a read off a `LangiumDocument` holds.
   // `severity` types as LSP's numeric enum here and as a string union on
   // `TransferDiagnostic`, which is why the two cannot stand in for each other.
   const plain = AstDocument.create<Root>('file:///a.x', 1, root);
   const severity: number | undefined = plain.diagnostics[0]?.severity;
   void severity;

   // Accepted: LSP's own reader narrows `message`, which is
   // `string | MarkupContent` on this shape and plain text only after the
   // encoder has run. Reaching for `.message` as a string is the mistake the
   // helper exists to prevent.
   const message: string = Diagnostic.getMessageString(diagnostic);
   void message;

   // @ts-expect-error and the helper takes only the LSP shape, so the wire
   // diagnostic cannot be read with it — the divergence is not just the extras
   const wireMessage: string = Diagnostic.getMessageString(wireDiagnostic);
   void wireMessage;

   // Accepted: an adopter narrowing to their validator's own shape. This is the
   // seam the parameter exists for — removing it would cost them this.
   const adopter = AstDocument.create<Root, RichDiagnostic>('file:///a.x', 1, root, rich);
   const ruleId: string | undefined = adopter.diagnostics[0]?.ruleId;
   void ruleId;

   // @ts-expect-error the WIRE diagnostic, which is the other end of the
   // encoder's conversion and shares no field types with this one
   const wire = AstDocument.create<Root, TransferDiagnostic>('file:///a.x', 1, root, []);
   void wire;

   // @ts-expect-error an arbitrary shape: the envelope reports what the build
   // produced, so the parameter may narrow that and may not replace it
   const arbitrary = AstDocument.create<Root, { id: string }>('file:///a.x', 1, root, []);
   void arbitrary;
}

describe('AstDocument diagnostic parameter', () => {
   it('compiles, which is the assertion', () => {
      expect(typeAssertions).toBeTypeOf('function');
   });
});
