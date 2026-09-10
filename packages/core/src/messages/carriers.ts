/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   hasMessageIdentity,
   messageData,
   type HydraniumMessageData,
   type MessageDefinition,
   type ParamsArg,
   type ResolvedMessage
} from '@hydranium/protocol';
import type { AstNode, DiagnosticData, DiagnosticInfo, Properties, ValidationAcceptor } from '@hydranium/langium';
import { Diagnostic } from 'vscode-languageserver-protocol';

/**
 * Raise a validation diagnostic from a declaration, so the call site never
 * restates the code or the sentence.
 *
 * `code` is omitted from `info` because this owns it — the framework claims LSP
 * `Diagnostic.code` for framework codes, which collides with no adopter today
 * and is a stated rule rather than an accident. `data` is deliberately NOT
 * omitted: Langium owns `data.code` for code-action dispatch, so a caller has to
 * be able to request a quick fix. The identity is merged OVER whatever they
 * pass, which makes the two conventions co-exist rather than compete.
 *
 * The identity lands in both `code` and `data.hydranium` on purpose. `code` is
 * what survives to the editor surface; Theia's converter drops `data` before the
 * squiggle, so a parameterised diagnostic falls back to the server's English
 * there while any adopter-owned surface can still render the parameterised form
 * from the marker store.
 *
 * `DiagnosticInfo` must be Langium's own type: a `Parameters<ValidationAcceptor>[2]`
 * shortcut compiles but loses the `property?: Properties<N>` relation. The `data`
 * re-type has to be an intersection rather than an `Omit` alone, because Langium
 * declares `data?: unknown` and an `unknown` cannot be spread.
 */
export function acceptMessage<S extends string, N extends AstNode, P extends Properties<N> = Properties<N>>(
   accept: ValidationAcceptor,
   severity: 'error' | 'warning' | 'info' | 'hint',
   message: MessageDefinition<S>,
   info: Omit<DiagnosticInfo<N, P>, 'code' | 'data'> & { data?: Partial<DiagnosticData> },
   ...params: ParamsArg<S>
): void {
   const data: HydraniumMessageData & Partial<DiagnosticData> = { ...info.data, ...messageData(message, ...params) };
   accept(severity, message.format(...params), { ...info, code: message.code, data });
}

/**
 * Recover the identity from a published diagnostic, for a surface that
 * identifies or renders diagnostics itself.
 *
 * `Diagnostic.message` is `string | MarkupContent` in LSP 3.17+, so the text
 * comes from upstream's own `Diagnostic.getMessageString` rather than a
 * hand-rolled narrowing — consuming the library in its style, and one fewer
 * place restating the union.
 */
export function resolvedFromDiagnostic(diagnostic: Diagnostic): ResolvedMessage | undefined {
   if (!hasMessageIdentity(diagnostic.data)) {
      return undefined;
   }
   return { ...diagnostic.data.hydranium, text: Diagnostic.getMessageString(diagnostic) };
}
