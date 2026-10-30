/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   DefaultGModelSerializer,
   DiagramConfiguration,
   GModelSerializer,
   GNode,
   Logger,
   ModelState,
   PopupModelFactory,
   RequestPopupModelAction,
   SetPopupModelAction
} from '@eclipse-glsp/server';
import { DocumentState } from '@hydranium/langium';
import 'reflect-metadata';
import { Container } from 'inversify';
import type { MarkdownIt } from 'markdown-it';
import type { Hover, Position } from 'vscode-languageserver-types';
import { describe, expect, it } from 'vitest';
import { HydraniumGlspRequestPopupModelActionHandler } from '../src/popup/hydranium-glsp-request-popup-model-action-handler.js';
import { makeCapturingGlspLogger } from '../src/testing/make-noop-glsp-logger.js';

// A quoted name `"NameOne"` at offset 10. The fake document puts every
// offset on line 0.
const NAME = { offset: 10, length: 9 };
const NAME_MIDDLE = { line: 0, character: 14 };

/** The parameters the handler asks the hover with. */
interface HoverParams {
   textDocument: { uri: string };
   position: Position;
}

interface Fakes {
   /** What the language's hover answers. `null` binds no hover provider, `'fails'` rejects. */
   hover?: Hover | null | 'fails';
   /** A bound popup factory, answering with a node of this id. */
   factoryAnswer?: string;
   /** How the drawn node stands: named in its document by default. */
   node?: 'nameless' | 'detached' | 'stale' | 'unlinked' | 'edited';
}

function createHandler(
   fakes: Fakes = {},
   handlerClass: typeof HydraniumGlspRequestPopupModelActionHandler = HydraniumGlspRequestPopupModelActionHandler
): {
   handler: HydraniumGlspRequestPopupModelActionHandler;
   asked: HoverParams[];
   warnings: () => string[];
} {
   const asked: HoverParams[] = [];
   const node: { $type: string; $cstNode: unknown; $document?: unknown } = { $type: 'Element', $cstNode: { root: { fullText: 'text' } } };
   // A stale node is not of its document's current build. An unlinked one's
   // document is being relinked. An edited one's text has changed and not been
   // reparsed yet.
   const text = fakes.node === 'edited' ? 'text, edited' : 'text';
   const document = {
      uri: { toString: () => 'file:///a.x' },
      state: fakes.node === 'unlinked' ? DocumentState.ComputedScopes : DocumentState.Validated,
      textDocument: { getText: () => text, positionAt: (offset: number) => ({ line: 0, character: offset }) }
   };
   if (fakes.node !== 'detached') {
      node.$document = document;
   }
   const nameNode = fakes.node === 'nameless' ? undefined : NAME;
   const hoverProvider = {
      // A Promise, as Langium's AstNodeHoverProvider answers.
      getHoverContent: async (_document: unknown, params: HoverParams): Promise<Hover | undefined> => {
         asked.push(params);
         if (fakes.hover === 'fails') {
            throw new Error('hover failed');
         }
         return fakes.hover ?? undefined;
      }
   };
   const services = {
      references: { NameProvider: { getNameNode: () => nameNode } },
      lsp: { HoverProvider: fakes.hover === null ? undefined : hoverProvider }
   };
   const { logger, lines } = makeCapturingGlspLogger();
   const container = new Container();
   container.bind(Logger).toConstantValue(logger);
   container.bind(DiagramConfiguration).toConstantValue({ typeMapping: new Map() });
   container.bind(GModelSerializer).to(DefaultGModelSerializer);
   container.bind(ModelState).toConstantValue({
      index: {
         find: (id: string) => (id === 'element' ? { id } : undefined),
         findSemanticElement: (id: string) => (id === 'element' ? node : undefined)
      },
      languageServicesFor: () => services,
      isCurrentBuiltNode: () => fakes.node !== 'stale'
   });
   if (fakes.factoryAnswer !== undefined) {
      const answer = fakes.factoryAnswer;
      container.bind(PopupModelFactory).toConstantValue({ createPopupModel: () => GNode.builder().id(answer).build() });
   }
   container.bind(HydraniumGlspRequestPopupModelActionHandler).to(handlerClass);
   return {
      handler: container.get(HydraniumGlspRequestPopupModelActionHandler),
      asked,
      warnings: () => lines.filter(line => line.level === 'warn').map(line => line.message)
   };
}

function request(elementId = 'element'): RequestPopupModelAction {
   return RequestPopupModelAction.create({ elementId, bounds: { x: 1, y: 2, width: 0, height: 0 } });
}

/** The HTML of each pre-rendered child of each sent popup. */
function popupHtml(actions: readonly unknown[]): string[] {
   return actions
      .filter(SetPopupModelAction.is)
      .flatMap(action => action.newRoot.children ?? [])
      .map(child => String((child as { code?: unknown }).code));
}

describe('HydraniumGlspRequestPopupModelActionHandler', () => {
   // At a quoted name's opening quote Langium's hover finds no declaration.
   it("answers with the language's hover inside the node's name, rendered from Markdown", async () => {
      const { handler, asked } = createHandler({ hover: { contents: { kind: 'markdown', value: '**kind** `NameOne`' } } });

      const actions = await handler.execute(request());

      expect(asked).toEqual([{ textDocument: { uri: 'file:///a.x' }, position: NAME_MIDDLE }]);
      expect(actions.filter(SetPopupModelAction.is).map(action => action.newRoot.type)).toEqual(['html']);
      expect(popupHtml(actions)).toEqual(['<p><strong>kind</strong> <code>NameOne</code></p>\n']);
   });

   it('escapes HTML the hover carries, so a doc comment injects no markup', async () => {
      const { handler } = createHandler({ hover: { contents: { kind: 'markdown', value: '<img src=x onerror=alert(1)>' } } });

      expect(popupHtml(await handler.execute(request()))).toEqual(['<p>&lt;img src=x onerror=alert(1)&gt;</p>\n']);
   });

   it('escapes a plain-text hover rather than reading it as Markdown, keeping its line breaks', async () => {
      const { handler } = createHandler({ hover: { contents: { kind: 'plaintext', value: '**a** <b>\nline\r\nnext\rlast' } } });

      expect(popupHtml(await handler.execute(request()))).toEqual(['<p>**a** &lt;b&gt;<br>line<br>next<br>last</p>']);
   });

   // Langium renders a doc comment's link tag as a `file:` link, which
   // markdown-it refuses by default and then prints as raw Markdown, path
   // included.
   it('shows a link as its text and an image as its alt text, whatever the scheme', async () => {
      const value = '[NameOne](file:///a.x#L3,5) [two](javascript:alert(1)) <https://b.x> ![`code` alt <i>](https://b.x/i.png)';
      const { handler } = createHandler({ hover: { contents: { kind: 'markdown', value } } });

      expect(popupHtml(await handler.execute(request()))).toEqual(['<p>NameOne two https://b.x <code>code</code> alt &lt;i&gt;</p>\n']);
   });

   it('sends no popup and logs no warning for a language without a hover', async () => {
      const { handler, warnings } = createHandler({ hover: null });

      expect(await handler.execute(request())).toEqual([]);
      expect(warnings()).toEqual([]);
   });

   it('sends no popup when the hover has no answer or the element draws no node', async () => {
      const { handler } = createHandler();

      expect(await handler.execute(request())).toEqual([]);
      expect(await handler.execute(request('other'))).toEqual([]);
   });

   it.each([
      [{ kind: 'markdown', value: '' } as const],
      [{ kind: 'plaintext', value: ' \r\n' } as const],
      [[]],
      [''],
      [[{ language: 'x', value: ' \n' }]]
   ])('sends no popup when the hover answers the empty contents %j', async contents => {
      const { handler } = createHandler({ hover: { contents } });

      expect(await handler.execute(request())).toEqual([]);
   });

   it('logs a warning and sends no popup when the hover fails, so the user sees no error', async () => {
      const { handler, warnings } = createHandler({ hover: 'fails' });

      expect(await handler.execute(request())).toEqual([]);
      expect(warnings()).toEqual([expect.stringMatching(/^Could not create the popup of 'element': Error: hover failed/)]);
   });

   it('keeps links as their text in a renderer a subclass extends from the default', async () => {
      class LineBreakHandler extends HydraniumGlspRequestPopupModelActionHandler {
         protected override createMarkdown(): MarkdownIt {
            return super.createMarkdown().set({ breaks: true });
         }
      }
      const { handler } = createHandler(
         { hover: { contents: { kind: 'markdown', value: '[NameOne](file:///a.x)\nline' } } },
         LineBreakHandler
      );

      expect(popupHtml(await handler.execute(request()))).toEqual(['<p>NameOne<br>\nline</p>\n']);
   });

   it('renders the deprecated MarkedString form, its code escaped whole', async () => {
      const { handler } = createHandler({ hover: { contents: ['**a**', { language: 'x', value: '```\n<b>' }] } });

      expect(popupHtml(await handler.execute(request()))).toEqual(['<p><strong>a</strong></p>\n<pre><code>```\n&lt;b&gt;</code></pre>\n']);
   });

   it.each(['nameless', 'detached', 'stale', 'unlinked', 'edited'] as const)(
      'sends no popup and asks no hover when the node is %s',
      async node => {
         const { handler, asked } = createHandler({ hover: { contents: 'unused' }, node });

         expect(await handler.execute(request())).toEqual([]);
         expect(asked).toEqual([]);
      }
   );

   it('leaves a bound PopupModelFactory to answer, as GLSP does', async () => {
      const { handler, asked } = createHandler({ hover: { contents: 'unused' }, factoryAnswer: 'from-factory' });

      const actions = await handler.execute(request());

      expect(actions.filter(SetPopupModelAction.is).map(action => action.newRoot.id)).toEqual(['from-factory']);
      expect(asked).toEqual([]);
   });
});
