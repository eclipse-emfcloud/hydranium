/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DocumentState, type AstNode, type LangiumDocument, UriUtils, type URI } from '@hydranium/langium';

/**
 * Build a typed AST-node fixture for unit tests.
 *
 * Langium AST node types are nominal interfaces generated from the grammar, so
 * an object literal can never structurally satisfy one — every test that needs
 * a node otherwise writes `{ $type: 'X', … } as unknown as SomeNode`. This
 * helper encapsulates that single unavoidable cast in one audited place and
 * hands back a value typed as `T`, so call sites stay cast-free and
 * intention-revealing.
 *
 * It deliberately does NOT set the `$synthetic` marker: a test fixture is not a
 * framework synthetic node, and marking it would change scope/index behaviour.
 * A test that wants a genuine synthetic node calls `markSynthetic` explicitly.
 *
 * @param node the node shape — `$type` is required; every other property is a
 *   value the test cares about (`$container`, cross-reference values, internal
 *   `_id` fields, …). The object is returned by reference, not copied.
 */
export function makeFakeAstNode<TAst extends AstNode = AstNode>(node: { $type: string } & Record<string, unknown>): TAst {
   return node as unknown as TAst;
}

/**
 * Options for {@link makeFakeDocument}.
 *
 * `text` defaults to a cycle-safe JSON rendering of `root` so fingerprint-based
 * dedup paths (e.g. `DataServer.dispatchPhaseEvent`) have a deterministic
 * input — passing an explicit value is only necessary when a test asserts on
 * the document text or relies on a grammar-realistic serialisation.
 */
export interface FakeDocumentOptions<TAst extends AstNode, TDiagnostic> {
   text?: string;
   version?: number;
   state?: DocumentState;
   diagnostics?: TDiagnostic[];
   /** Override the parserErrors / lexerErrors arrays returned from `parseResult`. */
   parseResult?: Partial<LangiumDocument<TAst>['parseResult']>;
   /**
    * Cross-reference list. Defaults to `[]`. Loosely typed because a full
    * Langium `Reference` is not constructible in a unit test, so tests
    * exercising CST / reference paths pass the minimal shape they need.
    */
   references?: readonly unknown[];
   /**
    * Full `textDocument` override for tests that need a real `TextDocument` —
    * the LSP position API (`positionAt` / `offsetAt`), which the minimal
    * default lacks. Defaults to a `{ uri, version, getText }` shell.
    */
   textDocument?: LangiumDocument<TAst>['textDocument'];
}

/**
 * Serialise `root` for the fake document's default text. AST fixtures routinely
 * carry `$container` back-references (child → parent → child), so a plain
 * `JSON.stringify` throws on the cycle; fall back to a minimal, deterministic
 * `$type` marker in that case. The default text is only for fingerprint / dedup
 * determinism — tests that assert on document text pass an explicit `text`.
 */
function stringifyFakeRoot(root: unknown): string {
   try {
      return JSON.stringify(root);
   } catch {
      return JSON.stringify({ $type: (root as { $type?: unknown } | undefined)?.$type });
   }
}

/**
 * Build a {@link LangiumDocument} shell suitable for stub services trees in
 * unit tests. The returned document satisfies the structural shape Langium
 * production code reads from — `uri`, `parseResult`, `textDocument`,
 * `diagnostics`, `state` — without spinning up a real grammar.
 *
 * Default state is {@link DocumentState.Validated} so callers exercising the
 * post-build read path (`getDocument` → assert AST) work without explicit
 * staging. Override via `options.state` for tests that gate on earlier
 * phases.
 */
export function makeFakeDocument<TAst extends AstNode = AstNode, TDiagnostic = unknown>(
   uri: string | URI,
   root: TAst,
   options: FakeDocumentOptions<TAst, TDiagnostic> = {}
): LangiumDocument<TAst> {
   const parsed = UriUtils.toUri(uri);
   const text = options.text ?? stringifyFakeRoot(root);
   const version = options.version ?? 1;
   const document = {
      uri: parsed,
      parseResult: {
         value: root,
         parserErrors: [],
         lexerErrors: [],
         ...options.parseResult
      },
      textDocument: options.textDocument ?? {
         uri: parsed.toString(),
         version,
         getText: () => text
      },
      diagnostics: (options.diagnostics ?? []) as never,
      references: options.references ?? [],
      state: options.state ?? DocumentState.Validated
   } as unknown as LangiumDocument<TAst>;
   // Wire the root → document back-reference the real LangiumDocumentFactory
   // sets, so consumers that resolve a node's owning document (e.g. the
   // transfer encoder deriving the encode context's URI) see the fake as
   // attached rather than detached.
   (root as { $document?: LangiumDocument<TAst> }).$document = document;
   return document;
}
