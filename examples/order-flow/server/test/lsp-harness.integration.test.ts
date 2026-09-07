/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `order-flow` LSP head over the real wire, keeping the assertions the
 * conformance kit is deliberately too generic to make. Counterpart to
 * `lsp-conformance.integration.test.ts`, which owns the protocol invariants.
 *
 * **What only this suite can cover: completion over the dependent-scope chain.**
 * `writes Order.status = PAID` resolves three references, each scoped by the
 * previous — `field` offers the fields of whatever `entity` resolved to, and
 * `literal` offers the literals of the enumeration THAT field's type resolves
 * to, a further hop through `Field.type.declared`. `OrderFlowProcessScopeProvider`
 * exists for those two, and completion is the only caller that drives them the
 * way an editor does: `project-visibility.test.ts` asserts candidate sets by
 * calling the provider directly, and the TCK's completion check asserts only
 * that the list is well-formed. A scope provider that returned every `Field` in
 * the workspace would pass both.
 *
 * Driven through `initialize({ workspaceFolders })` — one init, settled by the
 * harness — because every candidate set here depends on a linked `.domain` in
 * another document.
 */

import { NodeFileSystem } from '@hydranium/core/node';
import { type LspHarness, makeLspHarness, makeScratchWorkspace, type ScratchWorkspace } from '@hydranium/core/testing/node';
import { AllSemanticTokenModifiers, AllSemanticTokenTypes } from '@hydranium/langium/lsp';
import { Logger } from '@hydranium/protocol';
import { DidChangeConfigurationNotification } from 'vscode-languageserver';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainLanguageMetaData, ProcessLanguageMetaData } from '../src/language-server/generated/module.js';
import { createOrderFlowServices, type OrderFlowOptions } from '../src/language-server/order-flow-module.js';
import { WORKSPACE_ROOT } from './order-flow-harness.js';

let harness: LspHarness | undefined;
let workspace: ScratchWorkspace | undefined;

/** Boot the LSP head over a scratch copy of the sample workspace, settled. */
async function openWorkspace(options: OrderFlowOptions = {}): Promise<{ harness: LspHarness; uri: (relativePath: string) => string }> {
   workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-lsp-' });
   harness = makeLspHarness({
      createServices: connection => createOrderFlowServices({ connection, ...NodeFileSystem }, options).shared
   });
   await harness.initialize({ workspaceFolders: [{ uri: workspace.uri(), name: 'order-flow' }] });
   return { harness, uri: relativePath => workspace!.uri(relativePath) };
}

/** Distinguishes the probe documents, one per {@link completionLabels} call. */
let probeCount = 0;
/**
 * Completion labels at a position in a freshly opened `.process` document.
 *
 * Each call gets its OWN document URI. Reusing one compares against stale text:
 * a second `didOpen` for an already-open URI is not a legal LSP update and the
 * server ignores it, so the completion answers from the first document's
 * content and returns an empty list with no error anywhere.
 */
async function completionLabels(
   open: { harness: LspHarness; uri: (relativePath: string) => string },
   text: string,
   line: number,
   character: number
): Promise<string[]> {
   const target = open.uri(`orders/completion-probe-${(probeCount += 1)}.process`);
   open.harness.openDocument(target, text, ProcessLanguageMetaData.languageId);
   const list = await open.harness.completion(target, { line, character });
   return list.items.map(item => item.label);
}

/** One token, decoded out of the LSP wire encoding. */
interface DecodedToken {
   line: number;
   char: number;
   length: number;
   type: string;
   modifiers: string[];
}

/**
 * Undo the LSP wire encoding: `data` is a flat 5-tuple stream whose line and
 * (same-line) char are deltas from the previous token, with type and modifiers
 * as legend indices. Decoding makes an assertion readable as source positions
 * and token names instead of a wall of integers.
 */
function decodeSemanticTokens(data: readonly number[]): DecodedToken[] {
   const typeNames = Object.entries(AllSemanticTokenTypes);
   const modifierNames = Object.entries(AllSemanticTokenModifiers);
   const decoded: DecodedToken[] = [];
   let line = 0;
   let char = 0;
   for (let offset = 0; offset < data.length; offset += 5) {
      const [deltaLine, deltaChar, length, typeIndex, modifierBits] = data.slice(offset, offset + 5);
      line += deltaLine;
      char = deltaLine === 0 ? char + deltaChar : deltaChar;
      decoded.push({
         line,
         char,
         length,
         type: typeNames.find(([, index]) => index === typeIndex)?.[0] ?? `#${typeIndex}`,
         modifiers: modifierNames.filter(([, bit]) => (modifierBits & bit) !== 0).map(([name]) => name)
      });
   }
   return decoded;
}

describe('order-flow LSP head over the wire', () => {
   afterEach(() => {
      harness?.dispose();
      harness = undefined;
      workspace?.dispose();
      workspace = undefined;
   });

   it('settles the workspace before initialize resolves', async () => {
      const open = await openWorkspace();

      // The harness's settle contract, asserted rather than trusted: without it
      // `initialize({ workspaceFolders })` returns with nothing registered.
      const documents = open.harness.services.workspace.LangiumDocuments.all.toArray();
      expect(documents.length).toBeGreaterThanOrEqual(6);
      expect(documents.every(document => document.state >= 5)).toBe(true);
   });

   // The probe documents parse CLEANLY and completion is requested at the
   // offset where an existing reference begins. A truncated `writes Order.`
   // would be the more obvious way to ask, but it makes the request hang — the
   // document never reaches a state the completion handler will answer at — and
   // error recovery is a separate concern from scoping, which is what these
   // assert.
   const EFFECT_LINE = 'process Probe for Order {\n   task Pay writes Order.status = PAID\n}\n';

   it('offers only the resolved entity fields for the second reference of an effect', async () => {
      const open = await openWorkspace();

      // Character 25 is where `status` starts, i.e. just past `Order.`.
      const labels = await completionLabels(open, EFFECT_LINE, 1, 25);

      expect(labels).toContain('status');
      expect(labels).toContain('total');
      // `sku` and `quantity` are fields of LineItem, not Order. Langium's
      // default scope would offer every Field in the workspace, so this is the
      // assertion that separates a real dependent scope from a type-filtered
      // global lookup.
      expect(labels).not.toContain('sku');
      expect(labels).not.toContain('quantity');
   });

   it('offers only the literals of the field type for the third reference', async () => {
      const open = await openWorkspace();

      // Character 34 is where `PAID` starts — the literal slot, whose candidates
      // need a second hop through `Field.type.declared`.
      const labels = await completionLabels(open, EFFECT_LINE, 1, 34);

      expect(labels).toContain('PAID');
      expect(labels).toContain('CANCELLED');
      // Not an entity, not a field, not a stray declaration name.
      expect(labels).not.toContain('Order');
      expect(labels).not.toContain('status');
   });

   it('offers enum literals only where the field type is an enum', async () => {
      const open = await openWorkspace();

      // `Order.total` is typed `Money`, a value type — an enum literal is only
      // assignable where an enum is declared, so the scope is empty. Character
      // 33 is the literal slot on this line.
      const onValueType = await completionLabels(open, 'process Probe for Order {\n   task Pay writes Order.total = PAID\n}\n', 1, 33);
      expect(onValueType).not.toContain('PAID');
      expect(onValueType).not.toContain('NEW');

      // The counterweight, and it is load-bearing: the assertions above are
      // ABSENCES, and an empty scope is ALSO what a provider that offered
      // nothing anywhere would produce — `EnumLiteral`s are not in the global
      // index, so the fallback scope for this reference is empty too. Verified
      // by disabling the dependent scoping and watching this test go on passing
      // while the sibling candidate-set assertions failed. So it has to show,
      // in the same test, that the enum case really does offer them.
      const onEnum = await completionLabels(open, EFFECT_LINE, 1, 34);
      expect(onEnum).toContain('PAID');
   });

   it('resolves a cross-grammar reference in a document the client opens cold', async () => {
      const open = await openWorkspace();
      const target = open.uri('orders/cold.process');

      const published = open.harness.nextDiagnostics(target);
      open.harness.openDocument(
         target,
         'process Cold for Order {\n   task Settle writes Order.status = SHIPPED\n}\n',
         ProcessLanguageMetaData.languageId
      );

      // A document that was never on disk, resolving three references into a
      // `.domain` file discovered by the workspace scan.
      expect(await published).toEqual([]);
   });

   describe('the order-flow.log.level setting', () => {
      // The threshold is a process-global, so a test that moves it must put it
      // back or it leaks into every later suite in the same worker.
      const originalLevel = Logger.getLevel();
      afterEach(() => Logger.setLevel(originalLevel));

      /**
       * Push a `didChangeConfiguration` for the whole `order-flow` section and
       * wait for the resulting threshold change.
       *
       * Waiting on `Logger`'s value rather than sleeping: the notification is
       * fire-and-forget, so asserting on the next line samples before the server
       * has applied anything, and a passing test would prove nothing.
       */
      async function setLogLevelSetting(open: { harness: LspHarness }, level: string): Promise<void> {
         open.harness.client.sendNotification(DidChangeConfigurationNotification.type, {
            settings: { 'order-flow': { log: { level } } }
         });
         for (let attempt = 0; attempt < 100 && Logger.getLevel() !== level; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
         }
      }

      it('drives the process-wide threshold, live, without a restart', async () => {
         const open = await openWorkspace();
         // Not asserted as a precondition: the env baseline may have set it, and
         // the point is the TRANSITION, not the starting value.
         await setLogLevelSetting(open, 'debug');

         expect(Logger.getLevel()).toBe('debug');
         expect(Logger.isLevelEnabled('debug')).toBe(true);

         // The second change is what proves it is a live subscription rather
         // than a one-shot read at initialize.
         await setLogLevelSetting(open, 'error');
         expect(Logger.getLevel()).toBe('error');
         expect(Logger.isLevelEnabled('debug')).toBe(false);
      });

      // Deliberately NOT asserted here: that the GLSP logger follows. It reads
      // `Logger.getLevel()` and touches no services, so an assertion in this
      // suite would only restate the line above plus the enum mapping — both
      // already covered by `packages/glsp-server/test/glsp-client-logger.test.ts`
      // with a control. The reachability claim ("one setting, every head") is
      // carried by the global being global, not by a second test.
   });

   describe('semantic tokens', () => {
      it('advertises the capability, because the slot is bound', async () => {
         workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-lsp-' });
         harness = makeLspHarness({
            createServices: connection => createOrderFlowServices({ connection, ...NodeFileSystem }).shared
         });

         const result = await harness.initialize({ workspaceFolders: [{ uri: workspace.uri(), name: 'order-flow' }] });

         // Langium derives this from the bound `lsp.SemanticTokenProvider`, so
         // the assertion is on the WIRE rather than on the module: dropping the
         // binding silently removes the capability, and a client that never
         // sees it never sends a request, which reads as "no tokens" rather
         // than as a broken server.
         expect(result.capabilities.semanticTokensProvider).toBeDefined();
      });

      it('colours a cross-grammar reference from its target declaration', async () => {
         const open = await openWorkspace();
         const target = open.uri('orders/tokens.process');
         open.harness.openDocument(
            target,
            'process Tokens for Order {\n   task Pay writes Order.status = PAID\n}\n',
            ProcessLanguageMetaData.languageId
         );

         const decoded = decodeSemanticTokens((await open.harness.semanticTokens(target))?.data ?? []);
         const at = (line: number, char: number) => decoded.find(token => token.line === line && token.char === char);

         // `process Tokens` — the root's own name, a namespace declaration.
         expect(at(0, 8)).toMatchObject({ type: 'namespace', modifiers: ['declaration'] });
         // `task Pay` — a FlowNode declaration.
         expect(at(1, 8)).toMatchObject({ type: 'function', modifiers: ['declaration'] });

         // The three references of the effect, and the point of the test: every
         // one is coloured from a type declared in the OTHER grammar, and none
         // carries the declaration modifier. `Order` is an Entity (class),
         // `status` a Field (property), `PAID` an EnumLiteral (enumMember) — so
         // a `.process` file is coloured by `.domain`'s entries, resolved
         // through the one shared reflection.
         expect(at(1, 19)).toMatchObject({ type: 'class', modifiers: [] });
         expect(at(1, 25)).toMatchObject({ type: 'property', modifiers: [] });
         expect(at(1, 34)).toMatchObject({ type: 'enumMember', modifiers: [] });
      });

      /**
       * `highlightKeywords`, and specifically that the option REACHES the
       * provider.
       *
       * That is the part a unit test on the framework base cannot cover.
       * `createIntegrationServices` layers the adopter's modules LAST, and all
       * three of them bind `SemanticTokenProvider` — so an option delivered as
       * an extra module, or threaded to any binding other than the adopter's,
       * is silently overwritten and the tokens simply do not appear. The two
       * cases are asserted over the same source text so nothing but the option
       * differs.
       */
      describe('keywords', () => {
         const KEYWORD_SOURCE = 'process Tokens for Order {\n}\n';

         /** Every `keyword` token of {@link KEYWORD_SOURCE}, as `line:char`. */
         async function keywordPositions(options: OrderFlowOptions): Promise<string[]> {
            const open = await openWorkspace(options);
            const target = open.uri('orders/keywords.process');
            open.harness.openDocument(target, KEYWORD_SOURCE, ProcessLanguageMetaData.languageId);

            const decoded = decodeSemanticTokens((await open.harness.semanticTokens(target))?.data ?? []);
            return decoded.filter(token => token.type === 'keyword').map(token => `${token.line}:${token.char}`);
         }

         it('sends none by default, leaving them to the host TextMate grammar', async () => {
            expect(await keywordPositions({})).toEqual([]);
         });

         it('sends one per keyword when the host asks for them', async () => {
            // `process` at 0:0 and `for` at 0:15 — the two keywords of the
            // header. Positions rather than a count, because a count is
            // satisfied by two tokens anywhere and the braces are keywords
            // too: the assertion has to say WHICH leaves were claimed. The
            // trailing `{` / `}` are included for exactly that reason.
            expect(await keywordPositions({ highlightKeywords: true })).toEqual(['0:0', '0:15', '0:25', '1:0']);
         });

         it('leaves the name tokens alone either way', async () => {
            const open = await openWorkspace({ highlightKeywords: true });
            const target = open.uri('orders/keywords.process');
            open.harness.openDocument(target, KEYWORD_SOURCE, ProcessLanguageMetaData.languageId);

            const decoded = decodeSemanticTokens((await open.harness.semanticTokens(target))?.data ?? []);
            // `Tokens` is the root's own name and `Order` a cross-grammar
            // reference, so this says the AST pass still runs and that the
            // interleaved emission order does not disturb the wire deltas —
            // the builder sorts, so a keyword emitted after a later name still
            // decodes at its own position.
            expect(decoded.find(token => token.line === 0 && token.char === 8)).toMatchObject({ type: 'namespace' });
            expect(decoded.find(token => token.line === 0 && token.char === 19)).toMatchObject({ type: 'class' });
         });
      });
   });

   /**
    * **Why this example binds a `HoverProvider` at all.** Langium's default is
    * `MultilineCommentHoverProvider`, which answers with the declaration's
    * preceding comment found against `GrammarConfig.multilineCommentRules` —
    * `ML_COMMENT` alone. These three grammars comment with `//`, so the default
    * resolves every declaration correctly and then has nothing to say about any
    * of them: the request answers `null` and a client shows an empty hover while
    * every part of the path works.
    */
   describe('hover', () => {
      /** Hover text at a position in a freshly opened `.process` document. */
      async function hoverText(
         open: { harness: LspHarness; uri: (relativePath: string) => string },
         text: string,
         line: number,
         character: number
      ): Promise<string> {
         const target = open.uri(`orders/hover-probe-${(probeCount += 1)}.process`);
         open.harness.openDocument(target, text, ProcessLanguageMetaData.languageId);
         const hover = await open.harness.hover(target, { line, character });
         const contents = hover?.contents;
         return contents !== undefined && typeof contents === 'object' && 'value' in contents ? contents.value : '';
      }

      const EFFECT_DOCUMENT = 'process Probe for Order {\n   task Pay writes Order.status = PAID\n}\n';

      it('renders the declaration a cross-grammar reference resolves to', async () => {
         const open = await openWorkspace();

         // Character 19 is `Order` — a reference into the `.domain` grammar, so
         // the answer has to come from the shared index rather than from the
         // document under the cursor. The field list is what makes it the
         // resolved DECLARATION and not an echo of the reference text.
         const entity = await hoverText(open, EFFECT_DOCUMENT, 1, 19);
         expect(entity).toContain('**entity** `Order`');
         expect(entity).toContain('id, status, total, shipTo, lines');

         // Character 25 is `status`, one link further along the same chain.
         expect(await hoverText(open, EFFECT_DOCUMENT, 1, 25)).toBe('**field** `status`: `OrderStatus`');

         // Character 34 is `PAID`, whose hover names its enumeration — the hop
         // through `Field.type.declared` that the third reference is scoped by.
         expect(await hoverText(open, EFFECT_DOCUMENT, 1, 34)).toBe('**literal** `PAID` of `OrderStatus`');
      });

      it('renders a task from its computed effect summary', async () => {
         const open = await openWorkspace();

         // Character 8 is the `Pay` DECLARATION, so this hovers a node in the
         // document itself. `_effectSummary` is a computed property populated at
         // `ComputedScopes` by the AST-extension contribution — this is the only
         // place in the example where a derived property is visible to a user, so
         // an empty summary here means the contribution did not run rather than
         // that the task has no effects.
         expect(await hoverText(open, EFFECT_DOCUMENT, 1, 8)).toBe('**task** `Pay` — writes status=PAID (OrderStatus)');
      });

      it('shows the public modifier, because visibility decides reachability', async () => {
         const open = await openWorkspace();

         // Asked from a `.domain` probe, because `public` is only reachable
         // there: `Money` lives in `commerce-core` and nothing in a `.process`
         // grammar references a value type directly, so the process-document
         // route can reach the FIELD but never the declaration whose modifier
         // this is about.
         const target = open.uri('orders/hover-visibility.domain');
         open.harness.openDocument(target, 'entity HoverProbe {\n   amount: Money\n}\n', DomainLanguageMetaData.languageId);
         const money = await open.harness.hover(target, { line: 1, character: 11 });
         const text =
            money?.contents !== undefined && typeof money.contents === 'object' && 'value' in money.contents ? money.contents.value : '';

         // `public` is the only reason a document in `orders` can name this at
         // all — the one property of a declaration a reader cannot infer from the
         // reference in front of them.
         expect(text).toBe('`public` **valuetype** `Money` { amount, currency }');

         // The counterweight, in the same test: `Order` is NOT public, `orders`
         // being a leaf project, so it carries no prefix. Without this an
         // always-absent prefix would pass the assertion above's inverse and an
         // always-present one would pass nothing — the pair is what makes the
         // prefix mean the modifier.
         expect(await hoverText(open, EFFECT_DOCUMENT, 1, 19)).toMatch(/^\*\*entity\*\* `Order`/);
      });
   });
});
