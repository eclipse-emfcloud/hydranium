/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type Action,
   GHtmlRoot,
   type GModelRoot,
   GPreRenderedElement,
   ModelState,
   type RequestPopupModelAction,
   RequestPopupModelActionHandler,
   SetPopupModelAction
} from '@eclipse-glsp/server';
import { type AstNode, AstUtils, DocumentState, type LangiumDocument } from '@hydranium/langium';
import { describeErrorWithStack } from '@hydranium/protocol';
import { inject, injectable } from 'inversify';
import markdownit, { type MarkdownIt } from 'markdown-it';
import { type Hover, MarkupContent, MarkupKind, type Position } from 'vscode-languageserver-types';
import type { AbstractHydraniumGlspState } from '../state/abstract-hydranium-glsp-state.js';

/**
 * Answers a {@link RequestPopupModelAction} with the hover the hovered
 * element's language gives at the name of the AST node it draws, the text an
 * editor shows on that name. An element that draws no named node, or whose
 * language has no hover or no answer, gets no popup. A hover that fails logs a
 * warning and shows no popup, since a popup the user did not ask for should not
 * report an error.
 *
 * GLSP's handler calls a `PopupModelFactory` synchronously, and a
 * Langium hover may be a Promise, so this handler awaits the hover itself. A
 * bound `PopupModelFactory` still wins and runs as in GLSP. A subclass changes
 * where the hover is asked in {@link hoverPosition}, how it renders in
 * {@link renderHover}, {@link renderMarkdown} or {@link createMarkdown}, and
 * the popup's root in {@link createPopupModel}.
 *
 * `AbstractHydraniumGlspDiagramModule` registers it in place of GLSP's.
 */
@injectable()
export class HydraniumGlspRequestPopupModelActionHandler extends RequestPopupModelActionHandler {
   @inject(ModelState) declare protected modelState: AbstractHydraniumGlspState<AstNode, unknown>;

   protected __markdown: MarkdownIt | undefined;

   override async execute(action: RequestPopupModelAction): Promise<Action[]> {
      if (this.popupModelFactory) {
         return super.execute(action);
      }
      let html: string | undefined;
      try {
         html = await this.createPopupHtml(action);
      } catch (error: unknown) {
         this.logger.warn(`Could not create the popup of '${action.elementId}': ${describeErrorWithStack(error)}`);
         return [];
      }
      if (!html) {
         return [];
      }
      return [SetPopupModelAction.create(this.modelSerializer.createSchema(this.createPopupModel(html, action)))];
   }

   /** The popup holding `html`, at the bounds the client asked for. */
   protected createPopupModel(html: string, action: RequestPopupModelAction): GModelRoot {
      return GHtmlRoot.builder()
         .id('sprotty-popup')
         .canvasBounds(action.bounds)
         .add(GPreRenderedElement.builder().id(`${action.elementId}_popup`).code(html).build())
         .build();
   }

   /** The popup's HTML for the hovered element, or `undefined` or `''` for no popup. */
   protected async createPopupHtml(action: RequestPopupModelAction): Promise<string | undefined> {
      const node = this.modelState.index.findSemanticElement(action.elementId);
      const hoverProvider = node && this.modelState.languageServicesFor(node)?.lsp.HoverProvider;
      const document = node && hoverProvider && this.hoverableDocument(node);
      const position = document && this.hoverPosition(node, document);
      if (!hoverProvider || !document || !position) {
         return undefined;
      }
      const hover = await hoverProvider.getHoverContent(document, { textDocument: { uri: document.uri.toString() }, position });
      return hover && this.renderHover(hover);
   }

   /**
    * The document to ask `node`'s hover in, or `undefined` while that would
    * read the wrong text or references: when `node` is not of its document's
    * current build, or the document is not linked yet or has changed text
    * since the parse.
    */
   protected hoverableDocument(node: AstNode): LangiumDocument | undefined {
      const root = AstUtils.findRootNode(node);
      const document = root.$document;
      if (
         !document ||
         !this.modelState.isCurrentBuiltNode(node) ||
         document.state < DocumentState.Linked ||
         document.textDocument.getText() !== root.$cstNode?.root.fullText
      ) {
         return undefined;
      }
      return document;
   }

   /**
    * Where to ask `node`'s hover in `document`: inside its name, or
    * `undefined` for a node without one. Langium reads one character back at a
    * non-name character, so a STRING name's opening quote finds no declaration.
    */
   protected hoverPosition(node: AstNode, document: LangiumDocument): Position | undefined {
      const nameNode = this.modelState.languageServicesFor(node)?.references.NameProvider.getNameNode(node);
      return nameNode && document.textDocument.positionAt(nameNode.offset + Math.floor(nameNode.length / 2));
   }

   /**
    * The HTML of `hover`: Markdown rendered, plain text escaped, blank text as
    * `''` so it opens no popup.
    */
   protected renderHover({ contents }: Hover): string {
      if (MarkupContent.is(contents)) {
         if (contents.kind === MarkupKind.Markdown) {
            return this.renderMarkdown(contents.value);
         }
         return contents.value.trim() ? `<p>${this.markdown.utils.escapeHtml(contents.value).replace(/\r\n?|\n/g, '<br>')}</p>` : '';
      }
      // The deprecated `MarkedString` form: Markdown, or code in a language.
      return (Array.isArray(contents) ? contents : [contents])
         .map(part => {
            if (typeof part === 'string') {
               return this.renderMarkdown(part);
            }
            return part.value.trim() ? `<pre><code>${this.markdown.utils.escapeHtml(part.value)}</code></pre>\n` : '';
         })
         .join('');
   }

   /** `text` as HTML, with links as their text and images as their alt text. */
   protected renderMarkdown(text: string): string {
      return this.markdown.render(text);
   }

   protected get markdown(): MarkdownIt {
      return (this.__markdown ??= this.createMarkdown());
   }

   /**
    * The renderer of {@link renderMarkdown}. `html: false` escapes raw HTML. A
    * link renders as its text and an image as its alt text, so the popup
    * carries no href and loads nothing. Every scheme is accepted, or the
    * `file:` links Langium makes of a doc comment's link tags print as raw
    * Markdown. An override that enables more starts from
    * `super.createMarkdown()`.
    */
   protected createMarkdown(): MarkdownIt {
      const markdown = markdownit({ html: false });
      markdown.validateLink = () => true;
      markdown.renderer.rules.link_open = () => '';
      markdown.renderer.rules.link_close = () => '';
      markdown.renderer.rules.image = (tokens, index, options, env, renderer) =>
         renderer.renderInline(tokens[index]?.children ?? [], options, env);
      return markdown;
   }
}
