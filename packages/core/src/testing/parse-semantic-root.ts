/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Parse a document INTO THE WORKSPACE and hand back its typed semantic root.
 *
 * # What Langium's `parseHelper` leaves out
 *
 * `parseHelper` builds the text into a `LangiumDocument` and registers it on
 * `LangiumDocuments`. It does not put the text on the workspace filesystem. For
 * a single self-contained document that is enough; for anything a modelling
 * language actually tests it is not, because the framework has readers that go
 * to the filesystem rather than to the document registry:
 *
 * - project discovery reads descriptors through the `FileSystemProvider`, and a
 *   document whose project was never discovered gets no project-tier
 *   visibility — so a cross-project reference has nothing to resolve against;
 * - `DocumentBuilder.update` re-reads a document's text from the provider, so a
 *   rebuild of a never-written document sees whatever the provider has, not
 *   what was parsed;
 * - `getOrCreateDocument` for a URI not already registered loads it from the
 *   provider.
 *
 * The write is therefore not a convenience — it is what makes the document
 * exist to the parts of the framework that do not consult `LangiumDocuments`.
 *
 * # Semantic root, not document root
 *
 * Grammars split two ways. Some make the meaningful declaration the document
 * root itself; others wrap it, so the parse result is a container whose single
 * populated property is the thing under test. This resolves both by checking
 * the root against the guard first and then its direct children, which is why
 * the caller supplies a type guard rather than a type argument: the narrowing
 * has to happen at runtime, on a value whose shape only the guard knows.
 *
 * # Throws rather than asserting
 *
 * A syntax error makes every later assertion meaningless, so it is reported
 * here — but through a thrown error, not a test framework's `expect`. Reaching
 * for `expect` would bind this helper to one runner and put a global in a
 * shipped module; a throw carries the offending messages just as well and reads
 * the same under vitest, jest and a bare script.
 *
 * There is deliberately NO `$document` assignment. Langium sets `$document` on
 * the parse root, and `AstUtils.getDocument` walks `$container` upwards from any
 * descendant, so a returned child is already reachable to its document without
 * a cast onto a read-only field.
 */

import { type AstNode, AstUtils, type LangiumCoreServices, URI } from '@hydranium/langium';
import { type ParseHelperOptions, parseHelper } from '@hydranium/langium/test';
import type { WritableFileSystemProvider } from '../documents/ast-document-manager.js';

/** The one field this module reads off a lexer or parser error. */
interface ParseErrorMessage {
   readonly message: string;
}

/** Per-parse options for the function {@link makeParseSemanticRoot} returns. */
export interface ParseSemanticRootOptions extends ParseHelperOptions {
   /**
    * Lexer errors the parse is expected to produce. Defaults to `0`; set it
    * when the test's subject IS the malformed input, so the helper reports a
    * count that does not match rather than a count that is non-zero.
    */
   readonly lexerErrors?: number;
   /** Parser errors the parse is expected to produce. Defaults to `0`, same reasoning. */
   readonly parserErrors?: number;
}

/**
 * Build a parse function over `services` that returns roots narrowed by
 * `guard`.
 *
 * The returned function is reusable across a suite and each call parses one
 * document, so several calls against the same services build a linked
 * multi-document workspace — which is the point: a cross-reference needs a
 * target, and the target has to have been written too.
 *
 * `documentUri` is worth passing explicitly whenever the URI matters — a
 * project-relative location, a specific file extension in a multi-grammar
 * workspace. Without it Langium mints a counter-based `file:///N<ext>` URI,
 * which lands every document at the workspace root under the first extension
 * the language declares.
 */
export function makeParseSemanticRoot<TRoot extends AstNode>(
   services: LangiumCoreServices,
   guard: (node: unknown) => node is TRoot
): (text: string, options?: ParseSemanticRootOptions) => Promise<TRoot> {
   const parse = parseHelper(services);
   // Typed writable on `ServerSharedServices`; widened back to Langium's
   // read-only slot type by `LangiumCoreServices` on the parameter, so the
   // narrowing happens once here instead of at the write.
   const fileSystem = services.shared.workspace.FileSystemProvider as WritableFileSystemProvider;
   return async (text, options = {}) => {
      // BEFORE the parse whenever the URI is known, because the build the parse
      // triggers already has filesystem readers in it — project discovery reads
      // the descriptor off the provider during that build, and a file not yet
      // written is reported as unparseable, so the document's own project is
      // missing for the build that matters.
      if (options.documentUri !== undefined) {
         await fileSystem.writeFile(URI.parse(options.documentUri), text);
      }
      const document = await parse(text, options);
      // Only when the caller left the URI to Langium: the parse is what mints
      // it, so the write cannot precede it, and it has to land on the URI the
      // document was actually registered under or the two identities diverge
      // and every filesystem reader sees nothing.
      if (options.documentUri === undefined) {
         await fileSystem.writeFile(URI.parse(document.textDocument.uri), text);
      }

      const expectedLexerErrors = options.lexerErrors ?? 0;
      const expectedParserErrors = options.parserErrors ?? 0;
      const lexerErrors: readonly ParseErrorMessage[] = document.parseResult.lexerErrors;
      const parserErrors: readonly ParseErrorMessage[] = document.parseResult.parserErrors;
      if (lexerErrors.length !== expectedLexerErrors) {
         throw new Error(
            `Expected ${expectedLexerErrors} lexer error(s) in ${document.textDocument.uri}, got ${lexerErrors.length}:\n` +
               lexerErrors.map(error => `  ${error.message}`).join('\n')
         );
      }
      if (parserErrors.length !== expectedParserErrors) {
         throw new Error(
            `Expected ${expectedParserErrors} parser error(s) in ${document.textDocument.uri}, got ${parserErrors.length}:\n` +
               parserErrors.map(error => `  ${error.message}`).join('\n')
         );
      }

      const root = document.parseResult.value;
      if (guard(root)) {
         return root;
      }
      for (const child of AstUtils.streamContents(root)) {
         if (guard(child)) {
            return child;
         }
      }
      throw new Error(
         `No semantic root matching the guard in ${document.textDocument.uri}; the parse root is '${root.$type}' ` +
            `with children ${[...AstUtils.streamContents(root)].map(child => `'${child.$type}'`).join(', ') || '(none)'}.`
      );
   };
}
