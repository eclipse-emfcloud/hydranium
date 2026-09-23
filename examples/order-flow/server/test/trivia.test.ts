/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Trivia carried across a write that re-serializes the whole document — the
 * author's comments, and the whitespace their file ended with.
 *
 * This lives in the example rather than in `core` because the framework's own
 * harness substitutes the serializer with a stub, so the real serialize →
 * re-parse → splice chain only runs where real language services and a real
 * grammar exist.
 *
 * The assertions are on exact TEXT. A test that only counted surviving comments
 * could not see the failure that matters — a comment placed on the WRONG
 * declaration, which reads as if the author wrote it there.
 */

import {
   type AnchorSpan,
   CommentPreserver,
   type CommentTrivia,
   DefaultNameProvider,
   type DocumentComment,
   type DocumentTrivia,
   type HydraniumLanguageServices,
   type NameProvider,
   type TriviaContribution,
   type TriviaPreserver,
   type TriviaRegistry
} from '@hydranium/core';
import { URI } from '@hydranium/langium';
import { readFileSync } from 'node:fs';
import { describe, expect, it, onTestFinished } from 'vitest';
import { makeScratchWorkspaceHarness, makeServices, type OrderFlowHarness } from './order-flow-harness.js';
import { type OrderFlowServices } from '../src/language-server/order-flow-module.js';
import { type ProcessModel } from '../src/language-server/ast.js';
import { OrderFlowCommentPreserver } from '../src/language-server/order-flow-trivia.js';

/** A comment preserver whose splice breaks the line it lands in, to reach the parse net. */
class CorruptingCommentPreserver extends CommentPreserver {
   protected override editFor(): { at: number; text: string } {
      return { at: 0, text: '// swallows the whole document' };
   }
}

/**
 * Splices one named comment somewhere it cannot belong, leaving every other
 * comment to the framework — so a verification failure has a blast radius to
 * measure.
 */
class MisplacesOneComment extends CommentPreserver {
   protected override editFor(comment: DocumentComment, span: AnchorSpan, serialized: string): { at: number; text: string } {
      return comment.text.includes('MISPLACE ME')
         ? { at: serialized.length, text: `\n${comment.text}` }
         : super.editFor(comment, span, serialized);
   }
}

class BreaksOneInlineComment extends CommentPreserver {
   protected override editFor(comment: DocumentComment, span: AnchorSpan, serialized: string): { at: number; text: string } {
      return comment.text.includes('BREAK SYNTAX') ? { at: span.offset, text: '@@@' } : super.editFor(comment, span, serialized);
   }
}

class BreakingInlineTriviaContribution implements TriviaContribution {
   constructor(protected readonly services: HydraniumLanguageServices) {}

   registerTriviaPreservers(registry: TriviaRegistry): void {
      registry.register(new BreaksOneInlineComment(this.services));
   }
}

const BREAKS_ONE_INLINE = {
   trivia: {
      preservers: {
         comments: (services: HydraniumLanguageServices) => new BreakingInlineTriviaContribution(services)
      }
   }
};

/** The same, with isolation capped below the number of shared-line comments. */
const BREAKS_ONE_INLINE_CAPPED = {
   trivia: {
      preservers: {
         comments: (services: HydraniumLanguageServices) => ({
            registerTriviaPreservers: (registry: TriviaRegistry): void => {
               registry.register(new BreaksOneInlineComment(services, { maxIsolatedEdits: 1 }));
            }
         })
      }
   }
};

/** Binds {@link MisplacesOneComment} in place of the framework's. */
class MisplacingTriviaContribution implements TriviaContribution {
   constructor(protected readonly services: HydraniumLanguageServices) {}

   registerTriviaPreservers(registry: TriviaRegistry): void {
      registry.register(new MisplacesOneComment(this.services));
   }
}

const MISPLACES_ONE = {
   trivia: {
      preservers: {
         comments: (services: HydraniumLanguageServices) => new MisplacingTriviaContribution(services)
      }
   }
};

/** Binds {@link CorruptingCommentPreserver} in place of the framework's. */
class CorruptingTriviaContribution implements TriviaContribution {
   constructor(protected readonly services: HydraniumLanguageServices) {}

   registerTriviaPreservers(registry: TriviaRegistry): void {
      registry.register(new CorruptingCommentPreserver(this.services));
   }
}

/**
 * Language-tier module with no trivia preservers registered — how preservation
 * is switched off, there being no flag to clear.
 */
const NO_PRESERVERS = {
   trivia: {
      preservers: {
         comments: () => ({ registerTriviaPreservers: () => undefined }),
         documentEnding: () => ({ registerTriviaPreservers: () => undefined })
      }
   }
};

/**
 * Language-tier module naming `label` an identifier property alongside `name`,
 * which makes a `Branch` — identified by its label and carrying no `name` —
 * keyable by the comment preserver.
 */
const LABEL_IDENTIFIES = {
   references: {
      NameProvider: (services: OrderFlowServices): NameProvider => new DefaultNameProvider(services, { nameProperties: ['name', 'label'] })
   }
};

const SOURCE = `// leads the whole file

process Fulfillment for Order {
   // leads task Pay
   task Pay writes Order.status = PAID
   task Pick reads Order.id // trails the Pick line
   // separated by a blank line from Ship

   task Ship
   // dangles after the last member
}
// trails the whole file
`;

const URI_STRING = 'memory:///comments.process';

/** The comment preserver's payload out of an extraction, for asserting on what was taken. */
const commentsOf = (extracted: DocumentTrivia): readonly DocumentComment[] =>
   (extracted.find(entry => entry.preserver.id === 'comments')?.trivia as CommentTrivia | undefined)?.comments ?? [];

/** The document-ending preserver's payload out of an extraction. */
const endingOf = (extracted: DocumentTrivia): string | undefined =>
   extracted.find(entry => entry.preserver.id === 'document-ending')?.trivia as string | undefined;

/** Parse `source`, apply `mutate`, then run the write path's serialize + reattach. */
async function writeBack(
   harness: OrderFlowHarness,
   mutate: (root: ProcessModel) => void = () => undefined,
   source = SOURCE
): Promise<string> {
   return writeBackIn(harness, '.process', source, mutate);
}

/**
 * {@link writeBack} against whichever grammar `extension` routes to.
 *
 * **Every result is re-parsed before it is returned**, so each case below is
 * also a corruption guard. A splice edits syntax it did not produce, and a line
 * comment ends whatever shares its line — so a misplacement does not merely put
 * a comment in the wrong spot, it can write a file that no longer parses.
 */
async function writeBackIn(
   harness: OrderFlowHarness,
   extension: string,
   source: string,
   mutate: (root: never) => void = () => undefined
): Promise<string> {
   const uri = URI.parse(`memory:///comments${extension}`);
   const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
   expect(document.parseResult.parserErrors, source).toHaveLength(0);
   const services = harness.shared.ServiceRegistry.getServices(uri);
   const trivia = services.trivia.TriviaService;
   const extracted = trivia.extract(document);
   mutate(document.parseResult.value as never);
   const serialized = await services.serializer.Serializer.serializeAst(document.parseResult.value);
   const written = trivia.apply(serialized, extracted, uri);
   const reparsed = harness.shared.workspace.LangiumDocumentFactory.fromString(written, URI.parse(`memory:///verify${extension}`));
   expect(
      reparsed.parseResult.parserErrors.map(error => error.message),
      written
   ).toEqual([]);
   expect(
      reparsed.parseResult.lexerErrors.map(error => error.message),
      written
   ).toEqual([]);
   return written;
}

describe('trivia preservation', () => {
   it("registers both preservers by default, because dropping an author's comments is data loss", async () => {
      const harness = makeServices();
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(SOURCE, URI.parse(URI_STRING));
      const extracted = harness.process.trivia.TriviaService.extract(document);
      expect(extracted.map(entry => entry.preserver.id)).toEqual(['comments', 'document-ending']);
   });

   it('runs the example comment preserver for .layout and .process', async () => {
      // Asserting the TYPE, not the count: the ids are equal either way, and a
      // second preserver under the same id would throw at registration rather
      // than show up here, so a count cannot tell replacement from addition.
      const harness = makeServices();
      const preserverFor = (extension: string): TriviaPreserver | undefined => {
         const uri = URI.parse(`memory:///swap${extension}`);
         const source = extension === '.layout' ? 'layout L for P {}' : extension === '.domain' ? 'entity E {}' : 'process P for Order {}';
         const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
         return harness.shared.ServiceRegistry.getServices(uri)
            .trivia.TriviaService.extract(document)
            .find(entry => entry.preserver.id === 'comments')?.preserver;
      };
      expect(preserverFor('.layout')).toBeInstanceOf(OrderFlowCommentPreserver);
      expect(preserverFor('.process')).toBeInstanceOf(OrderFlowCommentPreserver);
      expect(preserverFor('.domain')).toBeInstanceOf(CommentPreserver);
      expect(preserverFor('.domain')).not.toBeInstanceOf(OrderFlowCommentPreserver);
   });

   it('returns the serializer output untouched when no preserver is registered', async () => {
      const harness = makeServices({ extraLanguageModules: [NO_PRESERVERS] });
      const text = await writeBack(harness);
      expect(text).not.toContain('//');
      // Neither comments NOR the ending: an empty registry carries no trivia at
      // all, which is not the same as the serializer having trimmed on its own.
      expect(text.endsWith('}')).toBe(true);
   });

   it('places leading, trailing, dangling and document-level comments', async () => {
      expect(await writeBack(makeServices())).toBe(
         [
            '// leads the whole file',
            '',
            'process Fulfillment for Order {',
            '   // leads task Pay',
            '   task Pay',
            '      writes Order.status = PAID',
            '   task Pick',
            '      reads Order.id // trails the Pick line',
            '   // separated by a blank line from Ship',
            '',
            '   task Ship',
            '   // dangles after the last member',
            '}',
            '// trails the whole file',
            ''
         ].join('\n')
      );
   });

   it('keeps a comment on its node when an integrity repair renames that node', async () => {
      // What both order-flow integrity rules do: rename in place. The anchor is
      // the AST object, so the key is read AFTER the rename and still matches.
      const text = await writeBack(makeServices(), root => {
         root.nodes[0].name = 'Pay__1';
      });
      expect(text).toContain('   // leads task Pay\n   task Pay__1');
   });

   it('keeps every comment on its own node when a sibling is inserted before them', async () => {
      // The failure an index-based anchor has: inserting at index 1 shifts every
      // later position, and comments land one declaration off. Name keying is
      // what closes it, so this asserts placement rather than survival.
      const text = await writeBack(makeServices(), root => {
         const injected = { ...root.nodes[2], name: 'Injected', $containerIndex: 1 } as ProcessModel['nodes'][number];
         root.nodes.splice(1, 0, injected);
         root.nodes.forEach((node, index) => ((node as { $containerIndex?: number }).$containerIndex = index));
      });
      expect(text).toContain('   // leads task Pay\n   task Pay');
      expect(text).toContain('      reads Order.id // trails the Pick line');
      expect(text).toContain('   // separated by a blank line from Ship\n\n   task Ship');
      expect(text).toContain('task Injected');
   });

   it("drops only the deleted node's comment, leaving the rest placed", async () => {
      // An anchor the write removed has nowhere to go. What this pins is that
      // the loss is CONFINED to that one comment.
      const text = await writeBack(makeServices(), root => {
         root.nodes.splice(0, 1);
         root.nodes.forEach((node, index) => ((node as { $containerIndex?: number }).$containerIndex = index));
      });
      expect(text).not.toContain('// leads task Pay');
      expect(text).toContain('// leads the whole file');
      expect(text).toContain('      reads Order.id // trails the Pick line');
      expect(text).toContain('   // dangles after the last member');
      expect(text).toContain('// trails the whole file');
   });

   it('keeps a comment on an effect identified by its semantic references', async () => {
      const source = 'process P for Order {\n   task Pay\n      // leads the effect\n      writes Order.status = PAID\n}\n';
      const text = await writeBack(makeServices(), () => undefined, source);
      expect(text).toContain('      // leads the effect\n      writes Order.status = PAID');
      expect(text).toContain('writes Order.status = PAID');
   });

   it('drops comments on duplicate effects instead of attaching them to either write', async () => {
      const source = [
         'process P for Order {',
         '   task Pay',
         '      // first write',
         '      writes Order.status = PAID',
         '      // second write',
         '      writes Order.status = PAID',
         '}',
         ''
      ].join('\n');
      const text = await writeBack(makeServices(), () => undefined, source);
      expect(text).not.toContain('// first write');
      expect(text).not.toContain('// second write');
   });

   it('keeps branch comments with their labelled branches', async () => {
      const source = [
         'process P for Order {',
         '   gateway PaymentOk',
         '      // explains the happy path',
         '      yes -> Pick',
         '      no -> Cancel',
         '   task Pick',
         '   task Cancel',
         '}',
         ''
      ].join('\n');
      expect(await writeBack(makeServices(), () => undefined, source)).toBe(source);
      expect(await writeBack(makeServices({ extraLanguageModules: [LABEL_IDENTIFIES] }), () => undefined, source)).toBe(source);
   });

   it('keeps transition comments with their endpoints and drops duplicate endpoint keys', async () => {
      const source = ['process P for Order {', '   task A', '   task B', '   // about A to B', '   transition A -> B', '}', ''].join('\n');
      expect(await writeBack(makeServices(), () => undefined, source)).toBe(source);
      const duplicates = source.replace('   transition A -> B', '   transition A -> B\n   transition A -> B');
      expect(await writeBack(makeServices(), () => undefined, duplicates)).not.toContain('// about A to B');
   });

   it('carries a comment across a unique transfer-model rename', async () => {
      const harness = makeServices();
      const uri = URI.parse(URI_STRING);
      const source = 'process P for Order {\n   // about Pay\n   task Pay\n   task Pick\n}\n';
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
      const trivia = harness.process.trivia.TriviaService.extract(document);
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');
      (transfer as unknown as { nodes: Array<{ name: string }> }).nodes[0].name = 'Charge';
      const serialized = await harness.process.serializer.Serializer.serializeTransfer(transfer);

      expect(harness.process.trivia.TriviaService.apply(serialized, trivia, uri)).toContain('   // about Pay\n   task Charge');
   });

   it('matches two independent renames in their original slots', async () => {
      const harness = makeServices();
      const uri = URI.parse(URI_STRING);
      const source = 'process P for Order {\n   // about Pay\n   task Pay\n   // about Pick\n   task Pick\n}\n';
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
      const trivia = harness.process.trivia.TriviaService.extract(document);
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');
      const nodes = (transfer as unknown as { nodes: Array<{ name: string }> }).nodes;
      nodes[0].name = 'Charge';
      nodes[1].name = 'Pack';
      const serialized = await harness.process.serializer.Serializer.serializeTransfer(transfer);
      const written = harness.process.trivia.TriviaService.apply(serialized, trivia, uri);

      expect(written).toContain('   // about Pay\n   task Charge');
      expect(written).toContain('   // about Pick\n   task Pack');
   });

   it('does not move comments when a rename reuses another node’s key', async () => {
      const harness = makeServices();
      const uri = URI.parse(URI_STRING);
      const source = 'process P for Order {\n   // about Pay\n   task Pay\n   // about Pick\n   task Pick\n}\n';
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
      const trivia = harness.process.trivia.TriviaService.extract(document);
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');
      const nodes = (transfer as unknown as { nodes: Array<{ name: string }> }).nodes;
      nodes[0].name = 'Pick';
      nodes[1].name = 'Pack';
      const serialized = await harness.process.serializer.Serializer.serializeTransfer(transfer);
      const written = harness.process.trivia.TriviaService.apply(serialized, trivia, uri);

      expect(written).not.toContain('// about Pay');
      expect(written).not.toContain('// about Pick');
   });

   it('drops ambiguous comments when two names are swapped', async () => {
      const harness = makeServices();
      const uri = URI.parse(URI_STRING);
      const source = 'process P for Order {\n   // about Pay\n   task Pay\n   // about Pick\n   task Pick\n}\n';
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
      const trivia = harness.process.trivia.TriviaService.extract(document);
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');
      const nodes = (transfer as unknown as { nodes: Array<{ name: string }> }).nodes;
      nodes[0].name = 'Pick';
      nodes[1].name = 'Pay';
      const serialized = await harness.process.serializer.Serializer.serializeTransfer(transfer);

      expect(harness.process.trivia.TriviaService.apply(serialized, trivia, uri)).not.toContain('//');
   });

   it('keeps a comment when a transfer update only inserts a sibling before it', async () => {
      const harness = makeServices();
      const uri = URI.parse(URI_STRING);
      const source = 'process P for Order {\n   // about Pay\n   task Pay\n}\n';
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
      const trivia = harness.process.trivia.TriviaService.extract(document);
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');
      const nodes = (transfer as unknown as { nodes: Array<{ name: string }> }).nodes;
      nodes.unshift({ ...nodes[0], name: 'Before' });
      const serialized = await harness.process.serializer.Serializer.serializeTransfer(transfer);

      expect(harness.process.trivia.TriviaService.apply(serialized, trivia, uri)).toContain('   // about Pay\n   task Pay');
   });

   it('keeps the comments a transfer-model insertion shifts, wherever it lands', async () => {
      // An insertion moves every later sibling to a new index, which is the
      // signal a swap also produces. What separates them is that an insertion
      // only ADDS identities, so the comments on the shifted siblings stay.
      const harness = makeServices();
      const uri = URI.parse(URI_STRING);
      const source = 'process P for Order {\n   // about Pay\n   task Pay\n   // about Pick\n   task Pick\n}\n';
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
      const trivia = harness.process.trivia.TriviaService.extract(document);
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');
      const nodes = (transfer as unknown as { nodes: Array<{ name: string }> }).nodes;
      nodes.splice(1, 0, { ...nodes[0], name: 'Between' });
      const serialized = await harness.process.serializer.Serializer.serializeTransfer(transfer);

      const written = harness.process.trivia.TriviaService.apply(serialized, trivia, uri);
      expect(written).toContain('   // about Pay\n   task Pay');
      expect(written).toContain('   // about Pick\n   task Pick');
   });

   it('keeps the comments a transfer-model deletion shifts', async () => {
      // The other half of the same rule, and the half the in-place delete case
      // cannot reach: there the anchor is gone from the tree and never gets as
      // far as comparing indices. Here the surviving siblings keep their
      // identities and only move, so their comments move with them.
      const harness = makeServices();
      const uri = URI.parse(URI_STRING);
      const source =
         'process P for Order {\n   // about Pay\n   task Pay\n   // about Pick\n   task Pick\n   // about Ship\n   task Ship\n}\n';
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
      const trivia = harness.process.trivia.TriviaService.extract(document);
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');
      (transfer as unknown as { nodes: unknown[] }).nodes.splice(0, 1);
      const serialized = await harness.process.serializer.Serializer.serializeTransfer(transfer);

      const written = harness.process.trivia.TriviaService.apply(serialized, trivia, uri);
      expect(written).toContain('   // about Pick\n   task Pick');
      expect(written).toContain('   // about Ship\n   task Ship');
      expect(written).not.toContain('// about Pay');
   });

   it('drops a swapped pair even when the same write appends a sibling', async () => {
      // The append makes the lists differ in length and leaves the key set
      // whole, so counting members and comparing key sets both read this as an
      // ordinary insertion. Only the ORDER of the keys the two lists share gives
      // the swap away — and without it each comment lands on the other task.
      const harness = makeServices();
      const uri = URI.parse(URI_STRING);
      const source = 'process P for Order {\n   // about Pay\n   task Pay\n   // about Pick\n   task Pick\n}\n';
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
      const trivia = harness.process.trivia.TriviaService.extract(document);
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');
      const nodes = (transfer as unknown as { nodes: Array<{ name: string }> }).nodes;
      nodes[0].name = 'Pick';
      nodes[1].name = 'Pay';
      nodes.push({ $type: 'Task', effects: [], name: 'Ship' } as never);
      const serialized = await harness.process.serializer.Serializer.serializeTransfer(transfer);

      expect(harness.process.trivia.TriviaService.apply(serialized, trivia, uri)).not.toContain('//');
   });

   it('follows the name when a payload renames a node and reuses the old name', async () => {
      // The limitation this preserver cannot reason its way out of, pinned so a
      // change to it is deliberate. Renaming Pay and inserting a new Pay leaves
      // text, keys and properties identical to inserting a sibling and leaving
      // Pay alone, so the comment follows the name onto a node its author never
      // saw. Only a caller that recorded which node it renamed could separate
      // the two, and the transfer model has nowhere to carry that.
      const harness = makeServices();
      const uri = URI.parse(URI_STRING);
      const source = 'process Reuse for Order {\n   // about Pay\n   task Pay\n}\n';
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
      const trivia = harness.process.trivia.TriviaService.extract(document);
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');
      const nodes = (transfer as unknown as { nodes: Array<{ name: string }> }).nodes;
      nodes[0].name = 'Charge';
      nodes.unshift({ $type: 'Task', name: 'Pay', effects: [] } as never);
      const serialized = await harness.process.serializer.Serializer.serializeTransfer(transfer);

      expect(harness.process.trivia.TriviaService.apply(serialized, trivia, uri)).toContain('   // about Pay\n   task Pay');
   });

   it('judges each list on its own when two containers answer to one key', async () => {
      // Duplicate names are what the integrity tier repairs, so they reach the
      // write path — and two containers then share an anchor key while their
      // lists have nothing to do with each other. A verdict remembered against
      // that key rather than against the container itself answers the second
      // list with the first list's reading.
      const harness = makeServices();
      const uri = URI.parse('memory:///duplicate.domain');
      const source = [
         'entity E {',
         '   // about alpha',
         '   alpha: ID',
         '   beta: ID',
         '}',
         'entity E {',
         '   // about gamma',
         '   gamma: ID',
         '   delta: ID',
         '}',
         ''
      ].join('\n');
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
      expect(document.parseResult.parserErrors).toHaveLength(0);
      const services = harness.shared.ServiceRegistry.getServices(uri);
      const trivia = services.trivia.TriviaService.extract(document);
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');
      const declarations = (transfer as unknown as { declarations: Array<{ fields: unknown[] }> }).declarations;
      // First list grows, which keeps its comments; second is reordered, which
      // cannot be told from its fields exchanging names and loses them.
      declarations[0].fields.unshift({ ...(declarations[0].fields[0] as object), name: 'extra' });
      declarations[1].fields.reverse();
      const serialized = await services.serializer.Serializer.serializeTransfer(transfer);

      const written = services.trivia.TriviaService.apply(serialized, trivia, uri);
      expect(written).toContain('// about alpha');
      expect(written).not.toContain('// about gamma');
   });

   it('drops comments on indistinguishable same-count reorders', async () => {
      const harness = makeServices();
      const uri = URI.parse(URI_STRING);
      const source = 'process P for Order {\n   // about Pay\n   task Pay\n   // about Pick\n   task Pick\n}\n';
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
      const trivia = harness.process.trivia.TriviaService.extract(document);
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');
      (transfer as unknown as { nodes: unknown[] }).nodes.reverse();
      const serialized = await harness.process.serializer.Serializer.serializeTransfer(transfer);

      expect(harness.process.trivia.TriviaService.apply(serialized, trivia, uri)).not.toContain('//');
   });

   it('does not guess a rename across a reorder', async () => {
      const harness = makeServices();
      const uri = URI.parse(URI_STRING);
      const source = 'process P for Order {\n   // about Pay\n   task Pay\n   task Pick\n}\n';
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
      const trivia = harness.process.trivia.TriviaService.extract(document);
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');
      const nodes = (transfer as unknown as { nodes: Array<{ name: string }> }).nodes;
      nodes[0].name = 'Charge';
      nodes.reverse();
      const serialized = await harness.process.serializer.Serializer.serializeTransfer(transfer);

      expect(harness.process.trivia.TriviaService.apply(serialized, trivia, uri)).not.toContain('// about Pay');
   });

   it('carries a child comment when its named parent is renamed', async () => {
      const harness = makeServices();
      const uri = URI.parse(URI_STRING);
      const source = 'process P for Order {\n   task Pay\n      // about the write\n      writes Order.status = PAID\n}\n';
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
      const trivia = harness.process.trivia.TriviaService.extract(document);
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');
      (transfer as unknown as { nodes: Array<{ name: string }> }).nodes[0].name = 'Charge';
      const serialized = await harness.process.serializer.Serializer.serializeTransfer(transfer);

      expect(harness.process.trivia.TriviaService.apply(serialized, trivia, uri)).toContain(
         '   task Charge\n      // about the write\n      writes Order.status = PAID'
      );
   });

   it('does not infer a rename when the node changes in another way too', async () => {
      const harness = makeServices();
      const uri = URI.parse(URI_STRING);
      const source = 'process P for Order {\n   // about Pay\n   task Pay writes Order.status = PAID\n}\n';
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
      const trivia = harness.process.trivia.TriviaService.extract(document);
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');
      const task = (transfer as unknown as { nodes: Array<{ name: string; effects: Array<{ literal: string }> }> }).nodes[0];
      task.name = 'Charge';
      task.effects[0].literal = 'SHIPPED';
      const serialized = await harness.process.serializer.Serializer.serializeTransfer(transfer);

      expect(harness.process.trivia.TriviaService.apply(serialized, trivia, uri)).not.toContain('// about Pay');
   });

   it('keeps two inline enum comments on their respective literals', async () => {
      const source = ['enum Status {', '   // about PAID', '   PAID,', '   // about SHIPPED', '   SHIPPED', '}', ''].join('\n');
      const written = await writeBackIn(makeServices(), '.domain', source);
      expect(written).toContain('// about PAID\n   PAID');
      expect(written).toContain('// about SHIPPED\n   SHIPPED');
      expect(await writeBackIn(makeServices(), '.domain', written)).toBe(written);
   });

   it('keeps a stack of inline literal comments together without adding blank lines', async () => {
      const source = ['enum Status {', '   // first note', '   // second note', '   PAID', '}', ''].join('\n');
      const written = await writeBackIn(makeServices(), '.domain', source);
      expect(written).toContain('// first note\n   // second note\n   PAID');
      expect(await writeBackIn(makeServices(), '.domain', written)).toBe(written);
   });

   describe('never moved onto another declaration', () => {
      it('drops both comments when two siblings share a name', async () => {
         // Duplicate names are what the integrity tier exists to repair, so they
         // reach the write path routinely. Merging their spans would put both
         // comments on whichever came first.
         const text = await writeBack(
            makeServices(),
            () => undefined,
            [
               'process P for Order {',
               '   // about the FIRST Pay',
               '   task Pay',
               '   // about the SECOND Pay',
               '   task Pay',
               '}',
               ''
            ].join('\n')
         );
         expect(text).toBe(['process P for Order {', '   task Pay', '   task Pay', '}', ''].join('\n'));
      });

      it('does not move a deleted duplicate’s comment onto its surviving sibling', async () => {
         const harness = makeServices();
         const uri = URI.parse(URI_STRING);
         const source = [
            'process P for Order {',
            '   // about the first Pay',
            '   task Pay',
            '   // about the second Pay',
            '   task Pay',
            '}',
            ''
         ].join('\n');
         const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
         const trivia = harness.process.trivia.TriviaService.extract(document);
         const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');
         (transfer as unknown as { nodes: unknown[] }).nodes.splice(0, 1);
         const serialized = await harness.process.serializer.Serializer.serializeTransfer(transfer);

         expect(harness.process.trivia.TriviaService.apply(serialized, trivia, uri)).toBe('process P for Order {\n   task Pay\n}\n');
      });

      it('keeps a note on an opening line with the container, not its first member', async () => {
         const text = await writeBackIn(
            makeServices(),
            '.domain',
            ['entity E { // NOTE ABOUT E', '   id: ID', '   code: ID', '}', ''].join('\n')
         );
         expect(text).toBe(['entity E { // NOTE ABOUT E', '   id: ID', '   code: ID', '}', ''].join('\n'));
      });

      it('keeps a comment inside an empty body on its own declaration', async () => {
         // The serializer collapses an empty body to `{}`, so there is no inside
         // left to put it in — but it must not escape to file scope, where it
         // would read as a comment about the NEXT declaration.
         const text = await writeBackIn(
            makeServices(),
            '.domain',
            ['entity Empty {', '   // why this is empty', '}', '', 'entity Other { id: ID }', ''].join('\n')
         );
         expect(text).toContain('entity Empty {} // why this is empty');
         expect(text).toContain('entity Other {');
      });

      it('keeps a comment from a declaration header on that header line', async () => {
         const text = await writeBack(
            makeServices(),
            () => undefined,
            ['process P /* MID HEADER */ for Order {', '   task Pay', '}', ''].join('\n')
         );
         expect(text).toBe(['process P for Order { /* MID HEADER */', '   task Pay', '}', ''].join('\n'));
      });

      it('keeps a trailing note on a header line that has children', async () => {
         const text = await writeBack(
            makeServices(),
            () => undefined,
            ['process P for Order {', '   task Pay // NOTE ABOUT PAY', '      writes Order.status = PAID', '}', ''].join('\n')
         );
         expect(text).toContain('   task Pay // NOTE ABOUT PAY\n      writes Order.status = PAID');
      });
   });

   it('carries .layout body comments, whose entries the framework cannot key', async () => {
      // Every `.layout` member is a `DiagramNode`, identified by the flow node it
      // positions rather than by any property a name provider could read — so the
      // framework default drops the entire body. This is the file a diagram drag
      // rewrites, which is why the example overrides the identity.
      const text = await writeBackIn(
         makeServices(),
         '.layout',
         [
            '// ABOUT THE LAYOUT',
            'layout L for Fulfillment {',
            '   // about Pay',
            '   node Pay at 40, 100 size 160, 60',
            '   node Pick at 440, 200 // trails pick',
            '}',
            ''
         ].join('\n')
      );
      expect(text).toContain('// ABOUT THE LAYOUT');
      expect(text).toContain('   // about Pay\n   node Pay at 40, 100 size 160, 60');
      expect(text).toContain('   node Pick at 440, 200 // trails pick');
   });

   it('emits LF for a comment captured from a CRLF document', async () => {
      // Serializers emit LF, so splicing CRLF comment text verbatim would put
      // lone CR bytes inside LF-terminated lines.
      const text = await writeBack(
         makeServices(),
         () => undefined,
         ['process P for Order {', '   /* one', '      two */', '   task Pay', '}', ''].join('\r\n')
      );
      // The whole file, ending included. A serializer emits LF and that cannot
      // be preserved, so keeping the ending's CRLF would leave the document's
      // only CRLFs at its very end — mixed terminators rather than a converted
      // file, which is the worse of the two outcomes available.
      expect(text).not.toContain('\r');
      expect(text.endsWith('}\n')).toBe(true);
   });

   describe('a splice never breaks the syntax it lands in', () => {
      it('appends rather than splitting a line the serializer emits whole', async () => {
         // `.domain` emits an enum body inline, so opening a new line after the
         // last literal would push `}` onto the comment's line and a `//`
         // comment would end the declaration there.
         const text = await writeBackIn(
            makeServices(),
            '.domain',
            ['enum Status {', '   PAID', '   // dangling', '}', '', 'entity Z { id: ID }', ''].join('\n')
         );
         expect(text).toContain('enum Status { PAID } // dangling');
      });

      it('writes serializer output that does not re-parse without splicing into it', async () => {
         // Anchors cannot be located in text the grammar cannot read, so nothing
         // is spliced. The ending still applies: it is a string operation on the
         // tail, needing none of the offsets the failed parse would have given.
         const harness = makeServices();
         const uri = URI.parse(URI_STRING);
         const document = harness.shared.workspace.LangiumDocumentFactory.fromString(SOURCE, uri);
         const service = harness.process.trivia.TriviaService;
         const extracted = service.extract(document);
         expect(commentsOf(extracted).length).toBeGreaterThan(0);

         const broken = 'process Broken for {{{';
         expect(service.apply(broken, extracted, uri)).toBe(`${broken}\n`);
      });

      it('drops the comments when a splice itself produces unreadable text', async () => {
         // The net UNDER the placement rules, which the case above never reaches
         // — that one fails while locating anchors, before any splice. No input
         // to the real placements is known to break a line, so the only way to
         // pin the net is a preserver whose splice deliberately does.
         const harness = makeServices({
            extraLanguageModules: [{ trivia: { preservers: { comments: services => new CorruptingTriviaContribution(services) } } }]
         });
         const uri = URI.parse(URI_STRING);
         const document = harness.shared.workspace.LangiumDocumentFactory.fromString(SOURCE, uri);
         const service = harness.process.trivia.TriviaService;
         const extracted = service.extract(document);
         const serialized = await harness.process.serializer.Serializer.serializeAst(document.parseResult.value);

         const written = service.apply(serialized, extracted, uri);
         expect(written).toBe(`${serialized}\n`);
         expect(written).not.toContain('//');
      });

      it('drops only the inline comment that fails to come back on its anchor', async () => {
         // The inline placement is the one verified by reading the result back,
         // and that check has to answer per edit. Falling back for the whole
         // document would let one comment the serializer's layout cannot hold
         // cost every other comment in the file its position.
         const text = await writeBackIn(
            makeServices({ extraLanguageModules: [MISPLACES_ONE] }),
            '.domain',
            ['enum Status {', '   // MISPLACE ME', '   PAID,', '   // about SHIPPED', '   SHIPPED', '}', ''].join('\n')
         );
         expect(text).toContain('// about SHIPPED');
         expect(text).not.toContain('MISPLACE ME');
      });

      it('stops isolating past its cap and drops the shared-line comments together', async () => {
         // Blaming one comment at a time re-splices and re-parses the document
         // per candidate, so an author who commented every literal of a large
         // file would pay its length times their number on a build's write lock.
         // The capped run reaches the text the search would have reached if all
         // of them were at fault, which is the text it settles on anyway.
         const source = ['enum Status {', '   // BREAK SYNTAX', '   PAID,', '   // about SHIPPED', '   SHIPPED', '}', ''].join('\n');
         const isolated = await writeBackIn(makeServices({ extraLanguageModules: [BREAKS_ONE_INLINE] }), '.domain', source);
         const capped = await writeBackIn(makeServices({ extraLanguageModules: [BREAKS_ONE_INLINE_CAPPED] }), '.domain', source);

         expect(isolated).toContain('// about SHIPPED');
         expect(capped).not.toContain('//');
      });

      it('drops a second trailing comment rather than nesting it inside the first', async () => {
         // Both literals end up on one line, so both trailing comments want the
         // end of it — and the second would land inside the first one's text,
         // where it stops being a comment and comes back as part of one on the
         // next read. Reading the result back is what turns that into a drop.
         const text = await writeBackIn(
            makeServices(),
            '.domain',
            ['enum Status {', '   PAID, // trails PAID', '   SHIPPED // trails SHIPPED', '}', ''].join('\n')
         );
         expect(text).not.toContain('// trails PAID // trails SHIPPED');
         expect(text.match(/\/\//g) ?? []).toHaveLength(1);
      });

      it('keeps other inline comments when one insertion breaks the parse', async () => {
         const text = await writeBackIn(
            makeServices({ extraLanguageModules: [BREAKS_ONE_INLINE] }),
            '.domain',
            ['enum Status {', '   // BREAK SYNTAX', '   PAID,', '   // about SHIPPED', '   SHIPPED', '}', ''].join('\n')
         );
         expect(text).toContain('// about SHIPPED');
         expect(text).not.toContain('BREAK SYNTAX');
      });
   });

   describe('stable under repeated writes', () => {
      // These files are rewritten over and over — an integrity repair, every
      // diagram drag, every form save — so a placement that shifts each time
      // walks a comment across the document one write at a time. Per-write
      // correctness does not imply that; only reapplying does.
      it.each([
         ['the full sample', '.process', SOURCE],
         ['an inline enum body', '.domain', ['enum Status {', '   // about PAID', '   PAID,', '   SHIPPED', '}', ''].join('\n')],
         ['a dangling comment in an inline body', '.domain', ['enum Status {', '   PAID', '   // dangling', '}', ''].join('\n')],
         ['a note on an opening line', '.domain', ['entity E { // NOTE', '   id: ID', '}', ''].join('\n')],
         ['a document-trailing comment', '.process', ['process P for Order {', '   task Pay', '}', '', '/* trails */', ''].join('\n')]
      ])('reaches a fixed point after one write (%s)', async (_label, extension, source) => {
         const harness = makeServices();
         const once = await writeBackIn(harness, extension, source);
         expect(await writeBackIn(harness, extension, once)).toBe(once);
      });
   });

   describe('blank lines', () => {
      it('keeps a blank line before a comment that trails the document', async () => {
         const source = ['process P for Order {', '   task Pay', '}', '', '/* or this */', ''].join('\n');
         expect(await writeBack(makeServices(), () => undefined, source)).toBe(source);
      });

      it('keeps a blank line before a comment dangling inside a block', async () => {
         const source = ['process P for Order {', '   task Pay', '', '   // dangles after a gap', '}', ''].join('\n');
         expect(await writeBack(makeServices(), () => undefined, source)).toBe(source);
      });
   });

   it('leaves a tab-indented block comment alone rather than mixing whitespace', async () => {
      // The indent delta is a character count, which means nothing when source
      // and target indent with different whitespace. Shifting anyway prepends
      // spaces in front of tabs.
      const text = await writeBack(
         makeServices(),
         () => undefined,
         ['process P for Order {', '\t/* one', '\t   two */', '\ttask Pay', '}', ''].join('\n')
      );
      expect(text).toContain('/* one\n\t   two */');
   });

   describe('multi-line comments', () => {
      it('shifts continuation lines by the same delta as the first', async () => {
         // A block comment carries its original per-line indentation inside its
         // own text, so emitting it at a new indentation without shifting the
         // rest leaves it trailing its old column. Authored at six spaces here;
         // the serializer puts members at three.
         const source = [
            'process P for Order {',
            '      /* line one',
            '         line two',
            '         line three */',
            '      task Pay',
            '}',
            ''
         ].join('\n');
         expect(await writeBack(makeServices(), () => undefined, source)).toBe(
            ['process P for Order {', '   /* line one', '      line two', '      line three */', '   task Pay', '}', ''].join('\n')
         );
      });

      it('leaves a block alone when its indentation does not move', async () => {
         const source = ['process P for Order {', '   /* one', '      two */', '   task Pay', '}', ''].join('\n');
         expect(await writeBack(makeServices(), () => undefined, source)).toBe(source);
      });
   });

   describe('document ending', () => {
      it('preserves several trailing newlines rather than normalising them', async () => {
         const text = await writeBack(makeServices(), () => undefined, 'process P for Order {\n   task Pay\n}\n\n\n');
         expect(text.endsWith('}\n\n\n')).toBe(true);
      });

      it('preserves the absence of a final newline', async () => {
         const text = await writeBack(makeServices(), () => undefined, 'process P for Order {\n   task Pay\n}');
         expect(text.endsWith('}')).toBe(true);
         expect(text.endsWith('\n')).toBe(false);
      });
   });

   it('finds `//` comments, which GrammarConfig.multilineCommentRules does not', async () => {
      // These grammars comment with `//`, and Langium populates
      // `multilineCommentRules` only with terminals whose regex spans lines. A
      // capture keyed on that list finds nothing here, and every other
      // assertion in this suite would pass vacuously against an empty capture.
      expect(makeServices().process.parser.GrammarConfig.multilineCommentRules).not.toContain('SL_COMMENT');
      expect(await writeBack(makeServices())).toContain('// leads the whole file');
   });

   it('carries trivia through ModelService.update, the form-editor write path', async () => {
      // The wiring, not the service: `modelToText` serializes the transfer model
      // and reattaches. Without it this file comes back with its explanatory
      // header gone and `task Pay writes …` split across two lines.
      const { harness, workspace } = await makeScratchWorkspaceHarness();
      onTestFinished(() => workspace.dispose());
      const uri = workspace.uri('orders/fulfillment.process');

      const before = harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri));
      const transfer = harness.shared.model.TransferEncoder.toTransfer(before!.parseResult.value, 'grammar');
      await harness.shared.model.ModelService.update({ uri, clientId: 'form-editor', model: transfer, basedOn: 'anything' });

      const after = harness.shared.workspace.TextDocuments.get(uri)?.getText();
      expect(after).toContain('// The behavioural half of `orders`. `for');
      expect(after).toContain('// the effect reports at a precise range.');
      expect(after?.endsWith('}\n')).toBe(true);
   });

   it('matches a transfer-model rename against a BUILT document, not just a parsed one', async () => {
      // The rename match compares the anchor's node with its candidate in the
      // re-serialized output. A built document carries computed properties the
      // output — freshly parsed, never built — does not, so a comparison over own
      // keys finds every candidate different and matches nothing. Driving this
      // through `ModelService.update` is what puts a built document on the source
      // side; every other rename case here parses its document from a string and
      // so cannot see the difference.
      const { harness, workspace } = await makeScratchWorkspaceHarness(scratch =>
         scratch.write('orders/rename.process', ['process Renamable for Order {', '   // about Pay', '   task Pay', '}', ''].join('\n'))
      );
      onTestFinished(() => workspace.dispose());
      const uri = workspace.uri('orders/rename.process');

      const before = harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri));
      // A task carries `_effectSummary` once built, which is exactly the state the
      // output side lacks — assert it, so this stops being a rename test the day
      // the example drops its computed properties.
      expect((before!.parseResult.value as ProcessModel).nodes[0]).toHaveProperty('_effectSummary');
      const transfer = harness.shared.model.TransferEncoder.toTransfer(before!.parseResult.value, 'grammar');
      (transfer as unknown as { nodes: Array<{ name: string }> }).nodes[0].name = 'Settle';
      await harness.shared.model.ModelService.update({ uri, clientId: 'form-editor', model: transfer, basedOn: 'anything' });

      expect(harness.shared.workspace.TextDocuments.get(uri)?.getText()).toContain('   // about Pay\n   task Settle');
   });

   it('preserves comments when saving an existing file that has not been loaded', async () => {
      const { harness, workspace } = await makeScratchWorkspaceHarness();
      onTestFinished(() => workspace.dispose());
      const source = '// cold file header\nprocess Cold for Order {\n   task Pay\n}\n\n';
      workspace.write('orders/cold.process', source);
      const uri = workspace.uri('orders/cold.process');
      expect(harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))).toBeUndefined();
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, URI.parse(uri));
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');

      await harness.shared.model.ModelService.save({ uri, clientId: 'form-editor', model: transfer, basedOn: 'anything' });

      expect(readFileSync(workspace.resolve('orders/cold.process'), 'utf8')).toBe(source);
   });

   it('still writes when the file it would take trivia from cannot be read', async () => {
      // Reading that file is an optimisation over writing the serializer's
      // output as emitted, so a read that fails has to cost the comments and
      // nothing else. Letting it escape would fail the user's save outright —
      // over a file the write was about to replace anyway.
      const { harness, workspace } = await makeScratchWorkspaceHarness();
      onTestFinished(() => workspace.dispose());
      const source = '// cold file header\nprocess Unreadable for Order {\n   task Pay\n}\n';
      workspace.write('orders/unreadable.process', source);
      const uri = workspace.uri('orders/unreadable.process');
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, URI.parse(uri));
      const transfer = harness.shared.model.TransferEncoder.toTransfer(document.parseResult.value, 'grammar');

      const fileSystem = harness.shared.workspace.FileSystemProvider as { readFile: (target: URI) => Promise<string> };
      const readFile = fileSystem.readFile;
      fileSystem.readFile = () => Promise.reject(new Error('EACCES: permission denied'));
      onTestFinished(() => {
         fileSystem.readFile = readFile;
      });

      await harness.shared.model.ModelService.update({ uri, clientId: 'form-editor', model: transfer, basedOn: 'anything' });

      const written = harness.shared.workspace.TextDocuments.get(uri)?.getText();
      expect(written).toContain('process Unreadable for Order {');
      expect(written).not.toContain('// cold file header');
   });

   it('carries comments through an integrity repair written to disk', async () => {
      // The sharpest path: a closed document repaired during an ordinary build,
      // persisted by the default `silent` sync mode with no user gesture. The
      // assertion is on the FILE, because that is where the loss lands.
      const { harness, workspace } = await makeScratchWorkspaceHarness(scratch =>
         scratch.write(
            'orders/duplicated.process',
            ['// explains why this process exists', 'process Duplicated for Order {', '   task Pay', '   task Pay', '}', ''].join('\n')
         )
      );
      onTestFinished(() => workspace.dispose());

      const onDisk = readFileSync(workspace.resolve('orders/duplicated.process'), 'utf8');
      // The repair ran — otherwise this test would pass without exercising it.
      expect(onDisk).toContain('task Pay__1');
      expect(onDisk).toContain('// explains why this process exists');
      expect(onDisk.endsWith('}\n')).toBe(true);
      expect(harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(workspace.uri('orders/duplicated.process')))).toBeDefined();
   });

   it('reports no comments and the ending for a document that carries none', async () => {
      const harness = makeServices();
      const uri = URI.parse(URI_STRING);
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString('process Bare for Order {\n   task Pay\n}\n', uri);
      const extracted = harness.process.trivia.TriviaService.extract(document);
      expect(commentsOf(extracted)).toHaveLength(0);
      expect(endingOf(extracted)).toBe('\n');
   });
});
