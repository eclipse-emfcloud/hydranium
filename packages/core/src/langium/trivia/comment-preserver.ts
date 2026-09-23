/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Tracer } from '@hydranium/protocol';
import {
   type AstNode,
   AstUtils,
   type CompositeCstNode,
   type CstNode,
   GrammarAST,
   GrammarUtils,
   isAstNode,
   type LangiumDocument,
   type URI
} from '@hydranium/langium';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type HydraniumLanguageServices } from '../language-module.js';
import { type TriviaContribution, type TriviaRegistry } from './trivia-contribution.js';
import { type TriviaPreserver } from './trivia-preserver.js';

/**
 * Where a comment sat relative to the node it belongs to.
 *
 * The CST records source order but not ownership, so getting this wrong
 * relocates a comment rather than losing it.
 *
 * - `atContainerStart` — before everything the container holds.
 * - `leading` — on its own line(s) above the node that follows it.
 * - `trailing` — on the same line the previous node ended on.
 * - `trailingOnContainer` — on the container's own header line, or amongst its
 *   syntax with more of the container still to come.
 * - `afterNode` — on its own line after the last node, still inside the
 *   container.
 * - `atContainerEnd` — after everything the container holds.
 */
export type CommentPlacement = 'atContainerStart' | 'leading' | 'trailing' | 'trailingOnContainer' | 'afterNode' | 'atContainerEnd';

/** One comment, bound to the AST node it hangs off rather than to an offset. */
export interface DocumentComment {
   /** The comment's source text, delimiters included. */
   readonly text: string;
   /**
    * The node the comment hangs off, held as the AST OBJECT rather than a path
    * or an offset, so a write that mutates the tree IN PLACE — an integrity
    * repair, a diagram gesture — is reflected without re-extracting.
    *
    * A transfer-model write supplies a separate object graph. A unique rename
    * can still be matched when its type, parent slot and other properties agree;
    * ambiguous matches are dropped.
    */
   readonly anchor: AstNode;
   readonly placement: CommentPlacement;
   /**
    * Blank lines between the comment and what it leads, for the placements that
    * emit it BEFORE its anchor.
    *
    * Captured for the placements that emit it after as well, where nothing reads
    * it: there the spacing an author means is the gap above the comment, which
    * {@link blankLinesBefore} carries.
    */
   readonly blankLinesAfter: number;
   /**
    * Blank lines between the comment and what PRECEDES it, for the placements
    * that emit it after their anchor. A comment separated from the closing brace
    * above it by a blank line reads as a new thought; re-emitting it flush
    * against that brace silently rewrites the author's spacing.
    */
   readonly blankLinesBefore: number;
   /**
    * The indentation the comment sat at in the source, when it owned its line —
    * `undefined` for one sharing a line with code, which is never reindented.
    *
    * A MULTI-LINE comment needs it to shift its continuation lines, which carry
    * their original indentation inside {@link text}: emitting the block at a new
    * indentation without shifting them leaves it hanging off its old column.
    *
    * A single-line one needs it whenever its anchor turns out to share a line,
    * because the indentation read off a mid-line offset is the code's and not
    * the comment's.
    */
   readonly sourceIndent?: string;
}

/** What {@link CommentPreserver} takes off a document. */
export interface CommentTrivia {
   readonly comments: readonly DocumentComment[];
   /** Original tree, retained to detect ambiguous or removed anchors at apply time. */
   readonly sourceRoot: AstNode;
}

/** Construction options for {@link CommentPreserver}. */
export interface CommentPreserverOptions extends LogNameOptions {
   /**
    * Registry id, defaulting to `comments`. Set it only to run a second comment
    * preserver beside the framework's; a subclass that REPLACES it keeps the
    * default so the contribution sub-key and the id stay in step.
    */
   readonly id?: string;
   /**
    * How many comments spliced into shared lines are worth blaming one at a
    * time when the result will not parse. Default {@link DEFAULT_ISOLATED_EDITS}.
    *
    * Isolating means re-splicing and re-parsing the whole document once per
    * candidate, so the search costs the document's length times their number.
    * Past this many the write drops them together instead — the same text it
    * would reach anyway if every one of them were at fault, without spending
    * that search on a build's write lock.
    */
   readonly maxIsolatedEdits?: number;
}

function isComposite(node: CstNode): node is CompositeCstNode {
   return 'content' in node;
}

function tokenNameOf(node: CstNode): string | undefined {
   return 'tokenType' in node ? (node as CstNode & { tokenType: { name: string } }).tokenType.name : undefined;
}

/**
 * Where a node begins and ends in the text it was located in, and which node
 * that is.
 *
 * Exported because {@link CommentPreserver.editFor} takes one, and an override
 * that cannot name its own parameter type has to restate the shape — which then
 * stops compiling the moment a field is added here.
 */
export interface AnchorSpan {
   readonly offset: number;
   readonly end: number;
   readonly owner: AstNode;
}

/**
 * One splice, with what it takes to check the risky kind afterwards.
 *
 * `inline` is set only for an edit that opens a line inside syntax the
 * serializer emitted whole; it carries what the comment must look like when the
 * result is read back, since that edit is the one that can hand a comment to
 * the wrong declaration.
 *
 * Exported for the same reason {@link AnchorSpan} is: the members that take one
 * are protected, so an override has to be able to name it.
 */
export interface InlineAwareEdit {
   readonly at: number;
   readonly text: string;
   /** Capture order, so several comments on one anchor keep the order written. */
   readonly order: number;
   readonly inline?: { readonly text: string; readonly key: string };
}

/**
 * Carries a document's comments across a write that re-serializes it from the
 * AST: extract against the node each comment hangs off, then splice into the
 * serializer's output, located by re-parsing it.
 *
 * **Emitting comments from inside a serializer instead drops them silently for
 * most nodes.** A hand-written concrete-syntax serializer reaches its children
 * through its own per-`$type` emitters, not through
 * `AbstractSerializer.serializeNode`, so a hook on that seam is reached by some
 * nodes and bypassed by the rest — and the ones it misses fail as absence,
 * which no test notices unless it asserts on exact text.
 */
export class CommentPreserver implements TriviaPreserver<CommentTrivia> {
   /**
    * **Registering a second preserver under this id throws.** A subclass added
    * ALONGSIDE the framework's — rather than replacing it by rebinding the
    * `comments` contribution sub-key — collides here, and the throw surfaces
    * from the first write rather than from server start, because the service is
    * constructed lazily. Pass an `id` to run both.
    */
   readonly id: string;
   readonly label = 'Comments';

   /** Default {@link CommentPreserverOptions.maxIsolatedEdits}. */
   static readonly DEFAULT_ISOLATED_EDITS = 24;

   protected readonly tracer: Tracer;
   protected readonly maxIsolatedEdits: number;
   protected commentTokenNames?: readonly string[];
   /** Set for the duration of one {@link apply}; see {@link cachedAnchorKey}. */
   protected keyMemo?: Map<AstNode, string | undefined>;
   /** Set for the duration of one {@link apply}; see {@link ambiguousRetainedKey}. */
   protected listVerdicts?: Map<AstNode, Map<string, boolean>>;

   constructor(
      protected readonly services: HydraniumLanguageServices,
      options: CommentPreserverOptions = {}
   ) {
      this.id = options.id ?? 'comments';
      this.maxIsolatedEdits = options.maxIsolatedEdits ?? CommentPreserver.DEFAULT_ISOLATED_EDITS;
      this.tracer = services.shared.Tracer.for(options.logName ?? 'CommentPreserver');
   }

   /**
    * Every comment terminal the grammar declares, by token name.
    *
    * Deliberately NOT `GrammarConfig.multilineCommentRules`, which Langium
    * populates only with terminals whose regex spans lines — so a grammar that
    * comments with `//` answers an empty list there and every one of its
    * comments would be invisible to a capture keyed on it.
    */
   protected getCommentTokenNames(): readonly string[] {
      if (!this.commentTokenNames) {
         this.commentTokenNames = this.services.Grammar.rules
            .filter(GrammarAST.isTerminalRule)
            .filter(rule => GrammarUtils.isCommentTerminal(rule))
            .map(rule => rule.name);
      }
      return this.commentTokenNames;
   }

   /**
    * Stable identity for one AST node, used to find it again in the
    * re-serialized text — or `undefined` when no stable identity exists.
    *
    * **Read through the `NameProvider`, so the anchor is what the grammar treats
    * as IDENTITY rather than whatever sits on `name`.** A grammar whose `name`
    * is a display label, carrying its identifier on another property, would
    * otherwise anchor comments to a value users retitle freely. A simple
    * retitle can be matched, but the real identifier remains the safer key.
    * `NameProviderOptions.nameProperties` names that property.
    *
    * **Whatever an override returns must survive a sibling being inserted into
    * the same list.** A positional key does not: every comment after the
    * insertion point is then written against the following declaration — a move,
    * which reads as text the author wrote there and which nothing downstream can
    * detect. That is why an unidentified node answers `undefined` here rather
    * than falling back to a container index, and why this cannot delegate to
    * `ElementKeyProvider`, whose name-based strategy makes exactly that fallback:
    * its keys are derived and consumed within one snapshot, where no position can
    * have shifted underneath them.
    *
    * Overriding is the supported route for a grammar that identifies some nodes
    * outside the naming surface altogether — by a cross-reference that is unique
    * among its siblings, say. Capture and lookup both read this one definition,
    * so an override cannot make those two disagree.
    *
    * **Matching a rename does not read it.** That comparison asks the
    * `NameProvider` what changed, so a node identified only by an override is
    * carried across a write that leaves its identity alone and dropped by one
    * that rewrites it — never misplaced, but never followed either.
    */
   protected anchorKey(node: AstNode): string | undefined {
      const nameProvider = this.services.references.NameProvider;
      const segments: string[] = [];
      let current: AstNode | undefined = node;
      while (current?.$container) {
         const name = nameProvider.getOwnName(current);
         if (name === undefined || name.length === 0) {
            return undefined;
         }
         segments.unshift(`${current.$type}#${this.escapeKeySegment(name)}`);
         current = current.$container;
      }
      return segments.length === 0 ? `@root:${node.$type}` : segments.join('/');
   }

   /**
    * Escape the characters {@link anchorKey} builds its keys out of, so a name
    * containing one cannot spell a key another node also answers to — which
    * would make two distinct nodes indistinguishable to the lookup.
    */
   protected escapeKeySegment(name: string): string {
      return name.replace(/[\\#/]/g, character => `\\${character}`);
   }

   /**
    * Collect every comment in `document`, each bound to the node it hangs off.
    *
    * Call this BEFORE the mutation that prompts the write. The anchors are AST
    * objects, so a rule that renames one in place is reflected automatically;
    * capturing afterwards would work too, but capturing first is what keeps the
    * CST and the comments describing the same state.
    */
   extract(document: LangiumDocument): CommentTrivia {
      // The capture reads the CST, which a residency policy may have shed.
      // Restored rather than skipped: skipping would lose the whole file's
      // comments for a document that had gone idle, silently and only under a
      // shedding strategy.
      this.services.shared.workspace.CstResidencyService.rehydrate(document);
      const root = document.parseResult.value.$cstNode;
      const commentTokens = this.getCommentTokenNames();
      if (!root || commentTokens.length === 0) {
         return { comments: [], sourceRoot: document.parseResult.value };
      }
      const source = document.textDocument.getText();
      const comments: DocumentComment[] = [];
      this.captureFrom(root, source, commentTokens, comments);
      return { comments, sourceRoot: document.parseResult.value };
   }

   /** Recursive half of {@link extract}: one composite node's content, then its children. */
   protected captureFrom(node: CstNode, source: string, commentTokens: readonly string[], into: DocumentComment[]): void {
      if (!isComposite(node)) {
         return;
      }
      const content = node.content;
      content.forEach((child, index) => {
         const tokenName = tokenNameOf(child);
         if (child.hidden && tokenName !== undefined && commentTokens.includes(tokenName)) {
            into.push(this.classify(child, index, node, source));
         }
         this.captureFrom(child, source, commentTokens, into);
      });
   }

   /**
    * Decide which node a comment belongs to, and how it sat against it.
    *
    * A comment on the same line the previous node ENDED on is that node's
    * trailing comment — checked first, because by source order it also precedes
    * whatever comes next, and reading it as the NEXT node's leading comment is
    * what relocates an end-of-line note onto the following declaration.
    */
   protected classify(comment: CstNode, index: number, container: CompositeCstNode, source: string): DocumentComment {
      const content = container.content;
      const ownsOwnNode = (candidate: CstNode | undefined): boolean =>
         candidate?.astNode !== undefined && candidate.astNode !== container.astNode;
      const realSibling = (from: number, step: number): CstNode | undefined => {
         for (let scan = from; scan >= 0 && scan < content.length; scan += step) {
            if (!content[scan].hidden) {
               return content[scan];
            }
         }
         return undefined;
      };

      const previous = realSibling(index - 1, -1);
      const next = realSibling(index + 1, 1);

      // Measured to whatever comes NEXT IN SOURCE, comment or not — never to the
      // next real node, which would skip the rest of a comment block and make
      // every line of it re-emit the whole gap that follows the block.
      const following = content[index + 1];
      const blankLinesAfter = following === undefined ? 0 : this.countBlankLines(source.slice(comment.end, following.offset));
      const preceding = index > 0 ? content[index - 1] : undefined;
      const blankLinesBefore = preceding === undefined ? 0 : this.countBlankLines(source.slice(preceding.end, comment.offset));

      // Only a comment that OWNS its line can be reindented — one sharing a line
      // with code keeps whatever spacing that line gives it.
      const lineStart = source.lastIndexOf('\n', comment.offset - 1) + 1;
      const beforeOnLine = source.slice(lineStart, comment.offset);
      const sourceIndent = beforeOnLine.trim().length === 0 ? beforeOnLine : undefined;

      const text = this.normalizeLineEndings(comment.text);
      const sharesLineWithPrevious = previous !== undefined && !source.slice(previous.end, comment.offset).includes('\n');

      if (sharesLineWithPrevious) {
         // On the same line as whatever precedes it, so it annotates that line.
         // When the preceding sibling is the CONTAINER's own syntax — an opening
         // brace, a name token, a keyword — the line is the container's header
         // and the comment belongs to the container, NOT to the first member
         // that happens to follow. Reading it as that member's leading comment
         // moves a note about the declaration onto its first child.
         return ownsOwnNode(previous)
            ? { text, anchor: previous.astNode!, placement: 'trailing', blankLinesAfter: 0, blankLinesBefore: 0 }
            : { text, anchor: container.astNode!, placement: 'trailingOnContainer', blankLinesAfter: 0, blankLinesBefore: 0 };
      }
      if (ownsOwnNode(next)) {
         return { text, anchor: next!.astNode!, placement: 'leading', blankLinesAfter, blankLinesBefore: 0, sourceIndent };
      }
      if (ownsOwnNode(previous)) {
         return { text, anchor: previous!.astNode!, placement: 'afterNode', blankLinesAfter: 0, blankLinesBefore, sourceIndent };
      }
      if (previous === undefined) {
         return { text, anchor: container.astNode!, placement: 'atContainerStart', blankLinesAfter, blankLinesBefore: 0, sourceIndent };
      }
      // Surrounded by the container's own syntax on both sides. A further
      // sibling after it means the comment sits INSIDE the construct — between
      // the braces of an empty body, or partway through a header — so it stays
      // with the container rather than being pushed past its closing syntax,
      // which would move it out to the enclosing scope. Only a comment with
      // nothing after it at all actually trails the container.
      const placement: CommentPlacement = next === undefined ? 'atContainerEnd' : 'trailingOnContainer';
      return { text, anchor: container.astNode!, placement, blankLinesAfter, blankLinesBefore, sourceIndent };
   }

   /**
    * Comment text with CRLF reduced to LF.
    *
    * Serializers emit LF, so splicing a comment captured from a CRLF document
    * verbatim puts lone CR bytes in the middle of LF-terminated lines.
    */
   protected normalizeLineEndings(text: string): string {
      return text.includes('\r') ? text.replace(/\r\n/g, '\n') : text;
   }

   /** Blank lines in a run of whitespace — one fewer than its newlines. */
   protected countBlankLines(gap: string): number {
      return Math.max(0, (gap.match(/\n/g)?.length ?? 0) - 1);
   }

   /**
    * Splice the captured comments back into `serialized`.
    *
    * A comment whose anchor the write deleted, or whose anchor has no stable
    * key, is dropped — counted at `debug`, because a silent drop is the failure
    * this preserver exists to remove and an unexplained one just moves it.
    */
   apply(serialized: string, trivia: CommentTrivia, uri: URI): string {
      if (trivia.comments.length === 0) {
         return serialized;
      }
      // Both memos are scoped to this call and not to the instance, because an
      // in-place write changes what a node's key IS: a repair that renames a
      // node between two writes would otherwise be answered from the first.
      this.keyMemo = new Map();
      this.listVerdicts = new Map();
      try {
         return this.applyComments(serialized, trivia, uri);
      } finally {
         this.keyMemo = undefined;
         this.listVerdicts = undefined;
      }
   }

   /** {@link apply}'s body, inside the per-write memos it sets up. */
   protected applyComments(serialized: string, trivia: CommentTrivia, uri: URI): string {
      const spliced = this.spliceComments(serialized, trivia, uri);
      // **Never hand back text the grammar cannot read.** A splice edits syntax
      // it did not produce, and a line comment in particular ends whatever
      // shares its line — so a placement that is merely wrong becomes a file
      // that no longer parses, written to disk by an integrity repair with no
      // user gesture. Dropping the comments is recoverable; corrupting the
      // document is not.
      if (spliced !== serialized && this.parse(spliced, uri) === undefined) {
         this.tracer.withUri(uri.toString()).warn('Reattaching comments produced text that does not parse; writing without them');
         return serialized;
      }
      return spliced;
   }

   /**
    * {@link anchorKey}, answered once per node per write.
    *
    * The key walks `$container` to the root building a segment each step, and
    * every stage of a write asks about the same nodes — locating spans, matching
    * a rename, judging a key the output kept. Recomputing makes each of those
    * stages cost nodes × depth, and the stages that scan a sibling list do it
    * once per comment.
    */
   protected cachedAnchorKey(node: AstNode): string | undefined {
      const memo = this.keyMemo;
      if (memo === undefined) {
         return this.anchorKey(node);
      }
      if (!memo.has(node)) {
         memo.set(node, this.anchorKey(node));
      }
      return memo.get(node);
   }

   /**
    * Parse `text` as a throwaway document, or `undefined` when it is not
    * readable — by reported error, or by a throw from a URI that routes to no
    * services. Does NOT register the result, so `LangiumDocuments` is untouched.
    */
   protected parse(text: string, uri: URI): LangiumDocument | undefined {
      let document: LangiumDocument;
      try {
         document = this.services.shared.workspace.LangiumDocumentFactory.fromString(text, uri);
      } catch {
         return undefined;
      }
      return document.parseResult.parserErrors.length > 0 || document.parseResult.lexerErrors.length > 0 ? undefined : document;
   }

   /** The splice itself, run before {@link apply}'s parse check. */
   protected spliceComments(serialized: string, trivia: CommentTrivia, uri: URI): string {
      const located = this.locate(serialized, uri);
      if (located === undefined) {
         return serialized;
      }

      const sourceOwners = new Map<string, AstNode>();
      const sourceCollisions = new Set<string>();
      const liveAnchors = new Set<AstNode>();
      for (const node of [trivia.sourceRoot, ...AstUtils.streamAllContents(trivia.sourceRoot)]) {
         liveAnchors.add(node);
         const key = this.cachedAnchorKey(node);
         if (key === undefined) {
            continue;
         }
         const owner = sourceOwners.get(key);
         if (owner !== undefined && owner !== node) {
            sourceCollisions.add(key);
         } else {
            sourceOwners.set(key, node);
         }
      }
      const needsRename = trivia.comments.some(comment => {
         const key = this.cachedAnchorKey(comment.anchor);
         return key !== undefined && !located.has(key);
      });
      const renamed = needsRename
         ? this.matchRenamedAnchors(trivia.sourceRoot, serialized, uri, located, sourceOwners, sourceCollisions)
         : new Map<AstNode, string>();

      const edits: InlineAwareEdit[] = [];
      let dropped = 0;
      trivia.comments.forEach((comment, order) => {
         const key = this.cachedAnchorKey(comment.anchor);
         const destination = key === undefined ? undefined : located.has(key) ? key : this.renamedKey(comment.anchor, key, renamed);
         const retained = destination === key ? located.get(key!) : undefined;
         const span =
            key === undefined ||
            !liveAnchors.has(comment.anchor) ||
            sourceCollisions.has(key) ||
            destination === undefined ||
            (retained !== undefined && this.ambiguousRetainedKey(comment.anchor, retained.owner))
               ? undefined
               : located.get(destination);
         if (span === undefined) {
            dropped++;
            return;
         }
         const edit = this.editFor(comment, span, serialized);
         edits.push({
            ...edit,
            order,
            inline: this.needsReadBack(comment, span, serialized) ? { text: comment.text, key: destination! } : undefined
         });
      });

      if (dropped > 0) {
         this.tracer.withUri(uri.toString()).debug(`Dropped ${dropped} comment(s): anchor deleted by the write, or carrying no stable key`);
      }

      // Stable by offset, then by capture order, so several comments landing on
      // one anchor keep the order the author wrote them in.
      edits.sort((left, right) => left.at - right.at || left.order - right.order);
      // **This is what licenses the mid-line split** `editFor` makes for a
      // `leading` comment whose anchor does not start its line. Parsing alone
      // cannot license it: text can parse perfectly well having handed the
      // comment to the following declaration instead. Re-extracting and
      // requiring the same anchor back is the only evidence the comment still
      // belongs where its author put it.
      //
      // A failed edit is dropped and the rest reassembled, since removing one
      // changes what the others land in; two rounds, then the inline edits go
      // as a set rather than iterating towards a text nothing has verified.
      let remaining: readonly InlineAwareEdit[] = edits;
      let result = this.assembleComments(serialized, remaining);
      for (let attempt = 0; attempt < 2; attempt++) {
         const failed = this.unverifiedInlineEdits(result, remaining, uri, serialized);
         if (failed.size === 0) {
            return result;
         }
         remaining = remaining.filter(edit => !failed.has(edit));
         result = this.assembleComments(serialized, remaining);
      }
      return this.assembleComments(
         serialized,
         remaining.filter(edit => edit.inline === undefined)
      );
   }

   /**
    * Whether this comment's edit has to be read back before it can be trusted.
    *
    * Both cases are the serializer having put the anchor on a line it shares.
    * A comment that wants the line above has to open one mid-construct; a
    * comment that wants the end of the anchor's line gets the end of a line that
    * may belong to a later sibling, and a second such comment lands inside the
    * first one's text and stops being a comment at all. Neither can be judged
    * from the offsets alone — only from what the text says once re-read.
    */
   protected needsReadBack(comment: DocumentComment, span: AnchorSpan, serialized: string): boolean {
      if (comment.placement === 'leading' || comment.placement === 'atContainerStart') {
         return !this.startOfLineIsBlank(serialized, span.offset);
      }
      return comment.placement === 'trailing' && this.endOfLineAt(serialized, span.end) !== span.end;
   }

   /**
    * Splice `edits` into `serialized`, in the order given.
    *
    * Two inline edits landing on one offset collapse into a single opened line,
    * so a stack of comments above one inline member comes back as a stack rather
    * than with a blank line between each pair.
    */
   protected assembleComments(serialized: string, edits: readonly InlineAwareEdit[]): string {
      let result = '';
      let cursor = 0;
      let previousInlineAt: number | undefined;
      for (const edit of edits) {
         const text = edit.inline !== undefined && edit.at === previousInlineAt ? edit.text.replace(/^\n[ \t]*/, '') : edit.text;
         result += serialized.slice(cursor, edit.at) + text;
         cursor = edit.at;
         previousInlineAt = edit.inline !== undefined ? edit.at : undefined;
      }
      return result + serialized.slice(cursor);
   }

   /**
    * Whether the output node now answering to `source`'s key is too likely to be
    * a DIFFERENT node for the comment to follow it.
    *
    * A key surviving the write normally means the node did. It can also mean a
    * sibling took the name over, which reads as the author having written the
    * comment about a declaration they never saw.
    *
    * **What is detectable is a list whose members changed places; what is not is
    * a payload that renames a node and gives its old name to another.** Those
    * two writes produce the same text and the same keys, and the node carrying
    * the old name afterwards is byte-identical under both readings, so no rule
    * over this evidence separates them. A caller that knows which node it
    * renamed is the only thing that could, and the transfer model carries no
    * such record.
    *
    * **The evidence is the ORDER of the keys the two lists share.** Adding or
    * removing siblings shifts the rest but leaves them in the same relative
    * order; only names changing places can put two shared keys out of order. A
    * list whose shared keys invert is therefore read as exchanged identities and
    * those siblings lose their comments — which costs a deliberate reorder its
    * comments, the conservative half of a trade whose other half is that a bare
    * swap cannot move one.
    *
    * **Comparing counts or key SETS instead misses cases each way.** A swap
    * alongside an insertion leaves the counts differing and the key set whole,
    * so neither test sees it; a deletion alongside an insertion leaves the counts
    * equal while every surviving sibling is still itself, so a count test drops
    * comments that were never in doubt.
    */
   protected ambiguousRetainedKey(source: AstNode, output: AstNode): boolean {
      const sourceParent = source.$container;
      const outputParent = output.$container;
      if (!sourceParent || !outputParent) {
         return false;
      }
      const parentKey = this.cachedAnchorKey(sourceParent);
      if (parentKey !== this.cachedAnchorKey(outputParent) || source.$containerProperty !== output.$containerProperty) {
         return true;
      }
      if (source.$containerIndex === output.$containerIndex) {
         return false;
      }
      const property = source.$containerProperty;
      if (property === undefined) {
         return true;
      }
      // Answered once per list rather than once per comment. One insertion moves
      // every later sibling, so each of their comments asks the same question of
      // the same two lists — and scanning both per comment costs the list's
      // length squared.
      //
      // Memoised against the parent NODE rather than its key, because two
      // same-named parents answer to one key and would otherwise share a verdict
      // about lists that have nothing to do with each other.
      const cached = this.listVerdicts?.get(sourceParent)?.get(property);
      if (cached !== undefined) {
         return cached;
      }
      const verdict = this.reidentifiedList(sourceParent, outputParent, property);
      if (this.listVerdicts !== undefined) {
         const byProperty = this.listVerdicts.get(sourceParent) ?? new Map<string, boolean>();
         byProperty.set(property, verdict);
         this.listVerdicts.set(sourceParent, byProperty);
      }
      return verdict;
   }

   /**
    * Whether the two lists differ in a way a plain insertion or deletion cannot
    * explain — the expensive half of {@link ambiguousRetainedKey}, split out so
    * it can be answered once per list.
    *
    * What says the members may have swapped names rather than moved:
    *
    * - **The lists are the same length.** Every rename chain over a fixed set of
    *   slots looks exactly like the shift a deletion plus an insertion produces,
    *   and for members carrying nothing but a name the properties match under
    *   both readings. Neither this nor anything downstream can separate them.
    * - **Keys present on both sides have changed places.** Adding or removing
    *   siblings shifts the rest but never reorders them, so an inversion is
    *   evidence no insertion or deletion can account for — and it is evidence
    *   the lengths alone miss, since a swap alongside an insertion leaves the
    *   counts differing and the key set whole.
    */
   protected reidentifiedList(sourceParent: AstNode, outputParent: AstNode, property: string): boolean {
      const before = (sourceParent as unknown as Record<string, unknown>)[property];
      const after = (outputParent as unknown as Record<string, unknown>)[property];
      if (!Array.isArray(before) || !Array.isArray(after)) {
         return true;
      }
      if (before.length === after.length) {
         return true;
      }
      const positions = new Map<string, number>();
      after.filter(isAstNode).forEach((node: AstNode, index: number) => {
         const key = this.cachedAnchorKey(node);
         if (key !== undefined && !positions.has(key)) {
            positions.set(key, index);
         }
      });
      let furthest = -1;
      for (const node of before.filter(isAstNode) as AstNode[]) {
         const key = this.cachedAnchorKey(node);
         const position = key === undefined ? undefined : positions.get(key);
         if (position === undefined) {
            continue;
         }
         if (position < furthest) {
            return true;
         }
         furthest = position;
      }
      return false;
   }

   /**
    * The inline edits `candidate` did not round-trip: each one whose comment came
    * back on a different anchor, and — when `candidate` does not parse at all —
    * each one that cannot be put back beside the others without breaking it
    * again. `serialized` is the unspliced text those trials are rebuilt from,
    * since finding the single edit at fault means assembling the rest without it.
    *
    * Costs a parse and an extract, so it answers empty without either when
    * nothing was spliced inline — which is every write into a document the
    * serializer lays out one declaration per line.
    */
   protected unverifiedInlineEdits(
      candidate: string,
      edits: readonly InlineAwareEdit[],
      uri: URI,
      serialized: string
   ): Set<InlineAwareEdit> {
      const inlineEdits = edits.filter(edit => edit.inline !== undefined);
      if (inlineEdits.length === 0) {
         return new Set();
      }
      const reparsed = this.parse(candidate, uri);
      if (reparsed === undefined) {
         if (inlineEdits.length > this.maxIsolatedEdits) {
            this.tracer
               .withUri(uri.toString())
               .debug(`Spliced text did not parse; dropping ${inlineEdits.length} shared-line comments without isolating`);
            return new Set(inlineEdits);
         }
         const retained = edits.filter(edit => edit.inline === undefined);
         const failed = new Set<InlineAwareEdit>();
         for (const edit of inlineEdits) {
            const trial = [...retained, edit].sort((left, right) => left.at - right.at || left.order - right.order);
            const text = this.assembleComments(serialized, trial);
            if (this.parse(text, uri) !== undefined && this.unverifiedInlineEdits(text, trial, uri, serialized).size === 0) {
               retained.push(edit);
            } else {
               failed.add(edit);
            }
         }
         return failed;
      }
      // Counted rather than scanned per edit: several comments can share an
      // anchor and a text, and each edit must consume one of them.
      const captured = new Map<string, number>();
      for (const comment of this.extract(reparsed).comments) {
         const seen = `${this.cachedAnchorKey(comment.anchor) ?? ''}\u0000${comment.text}`;
         captured.set(seen, (captured.get(seen) ?? 0) + 1);
      }
      const failed = new Set<InlineAwareEdit>();
      for (const edit of inlineEdits) {
         const expected = edit.inline!;
         const wanted = `${expected.key}\u0000${expected.text}`;
         const remaining = captured.get(wanted) ?? 0;
         if (remaining === 0) {
            failed.add(edit);
         } else {
            captured.set(wanted, remaining - 1);
         }
      }
      return failed;
   }

   protected renamedKey(anchor: AstNode, oldKey: string, renamed: Map<AstNode, string>): string | undefined {
      let current: AstNode | undefined = anchor;
      while (current !== undefined) {
         const newPrefix = renamed.get(current);
         const oldPrefix = this.cachedAnchorKey(current);
         if (newPrefix !== undefined && oldPrefix !== undefined && (oldKey === oldPrefix || oldKey.startsWith(`${oldPrefix}/`))) {
            return newPrefix + oldKey.slice(oldPrefix.length);
         }
         current = current.$container;
      }
      return undefined;
   }

   protected matchRenamedAnchors(
      sourceRoot: AstNode,
      serialized: string,
      uri: URI,
      located: Map<string, AnchorSpan>,
      sourceOwners: Map<string, AstNode>,
      sourceCollisions: Set<string>
   ): Map<AstNode, string> {
      const matches = new Map<AstNode, string>();
      const output = this.parse(serialized, uri);
      if (output === undefined) {
         return matches;
      }
      const outputNodes = [output.parseResult.value, ...AstUtils.streamAllContents(output.parseResult.value)];
      const unmatchedBySlot = new Map<string, AstNode[]>();
      for (const node of outputNodes) {
         const key = this.cachedAnchorKey(node);
         const parent = node.$container && this.cachedAnchorKey(node.$container);
         if (key === undefined || !located.has(key) || sourceOwners.has(key) || parent === undefined) {
            continue;
         }
         const slot = JSON.stringify([parent, node.$containerProperty, node.$containerIndex, node.$type]);
         const candidates = unmatchedBySlot.get(slot) ?? [];
         candidates.push(node);
         unmatchedBySlot.set(slot, candidates);
      }
      const claimed = new Map<AstNode, AstNode>();
      const ambiguous = new Set<AstNode>();
      for (const source of [sourceRoot, ...AstUtils.streamAllContents(sourceRoot)]) {
         const key = this.cachedAnchorKey(source);
         if (key === undefined || sourceCollisions.has(key) || located.has(key) || !source.$container) {
            continue;
         }
         const parentKey = this.cachedAnchorKey(source.$container);
         if (parentKey === undefined) {
            continue;
         }
         const slot = JSON.stringify([parentKey, source.$containerProperty, source.$containerIndex, source.$type]);
         const candidates = (unmatchedBySlot.get(slot) ?? []).filter(candidate => this.sameAsideFromName(source, candidate));
         if (candidates.length === 1) {
            const candidate = candidates[0];
            if (ambiguous.has(candidate)) {
               continue;
            }
            if (claimed.has(candidate)) {
               matches.delete(claimed.get(candidate)!);
               ambiguous.add(candidate);
            } else {
               matches.set(source, this.cachedAnchorKey(candidate)!);
            }
            claimed.set(candidate, source);
         }
      }
      return matches;
   }

   protected sameAsideFromName(source: AstNode, target: AstNode): boolean {
      const nameProvider = this.services.references.NameProvider;
      const before = nameProvider.getOwnName(source);
      const after = nameProvider.getOwnName(target);
      if (before === undefined || after === undefined || before === after) {
         return false;
      }
      let renamed = false;
      for (const key of this.comparableProperties(source.$type)) {
         const oldValue = (source as unknown as Record<string, unknown>)[key];
         const newValue = (target as unknown as Record<string, unknown>)[key];
         if (oldValue === before && newValue === after) {
            renamed = true;
         } else if (!this.sameValue(oldValue, newValue)) {
            return false;
         }
      }
      return renamed;
   }

   /**
    * The properties `type` declares in the grammar — everything a rename match
    * may compare, and nothing else.
    *
    * **Comparing own keys instead compares derived state, and matches nothing.**
    * A built document carries whatever `ast.extensions` computed onto its nodes;
    * the re-parsed serializer output is never built and carries none of it. Every
    * candidate then differs on a property the grammar never mentioned, so no
    * rename is ever matched — on the real write path only, because a document a
    * test parses from a string has no computed state to disagree about.
    */
   protected comparableProperties(type: string): readonly string[] {
      return Object.keys(this.services.shared.AstReflection.getTypeMetaData(type).properties);
   }

   protected sameValue(left: unknown, right: unknown): boolean {
      if (left === right) {
         return true;
      }
      if (Array.isArray(left) && Array.isArray(right)) {
         return left.length === right.length && left.every((value, index) => this.sameValue(value, right[index]));
      }
      if (isAstNode(left) && isAstNode(right)) {
         if (left.$type !== right.$type) {
            return false;
         }
         return this.comparableProperties(left.$type).every(key =>
            this.sameValue((left as unknown as Record<string, unknown>)[key], (right as unknown as Record<string, unknown>)[key])
         );
      }
      if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
         if ('$refText' in left && '$refText' in right) {
            return left.$refText === right.$refText;
         }
      }
      return false;
   }

   /** The insertion this comment's placement implies, against its anchor's span. */
   protected editFor(comment: DocumentComment, span: AnchorSpan, serialized: string): { at: number; text: string } {
      const blanks = '\n'.repeat(comment.blankLinesAfter);
      const blanksBefore = '\n'.repeat(comment.blankLinesBefore);
      switch (comment.placement) {
         case 'trailing':
            return { at: this.endOfLineAt(serialized, span.end), text: ` ${comment.text}` };
         // Appended to the container's FIRST line, which is its header. The
         // comment may have sat further along that line in the source — mid
         // header, or between braces the serializer has since collapsed to `{}`
         // — and the exact column is not recoverable from a re-emitted
         // document. The line is, and that is what keeps it on its own
         // declaration instead of on a neighbour.
         case 'trailingOnContainer':
            return { at: this.endOfLineAt(serialized, span.offset), text: ` ${comment.text}` };
         // Both of these open a NEW line after the anchor, which is only safe
         // while nothing else shares the anchor's line. When the serializer put
         // the anchor and its container's closing syntax together — an inline
         // enum body, say — splitting there pushes that syntax onto the comment's
         // line, and a line comment then ends the construct. Appending to the
         // line instead keeps the comment on the same declaration and the
         // document readable.
         case 'afterNode': {
            if (!this.restOfLineIsBlank(serialized, span.end)) {
               return { at: this.endOfLineAt(serialized, span.end), text: ` ${comment.text}` };
            }
            const indent = this.indentAt(serialized, span.offset);
            return { at: span.end, text: `\n${blanksBefore}${indent}${this.reindent(comment, indent)}` };
         }
         case 'atContainerEnd':
            return this.restOfLineIsBlank(serialized, span.end)
               ? { at: span.end, text: `\n${blanksBefore}${comment.text}` }
               : { at: this.endOfLineAt(serialized, span.end), text: ` ${comment.text}` };
         case 'atContainerStart':
         case 'leading':
         default: {
            // `leading` means "on the line above", and the anchor may sit
            // mid-line — a member of a body the serializer emitted inline.
            // **Opening a line there is sound only because the caller reads the
            // result back and requires this comment on this same anchor**,
            // dropping the edit when it is not. Unguarded, the split strands the
            // rest of the construct at column zero and lands somewhere different
            // again on the next write.
            if (!this.startOfLineIsBlank(serialized, span.offset)) {
               const indent = comment.sourceIndent ?? this.indentAt(serialized, span.offset);
               return { at: span.offset, text: `\n${indent}${this.reindent(comment, indent)}\n${blanks}${indent}` };
            }
            const indent = this.indentAt(serialized, span.offset);
            return { at: span.offset, text: `${this.reindent(comment, indent)}\n${blanks}${indent}` };
         }
      }
   }

   /**
    * A multi-line comment's continuation lines, shifted by the same delta its
    * first line moves — so a block emitted at a new indentation stays square
    * instead of trailing its original column.
    *
    * **Only the leading whitespace run is touched, and an outdent removes at
    * most what is there** — shifting further would eat the comment's own text.
    *
    * Single-line comments and ones sharing a line with code are returned
    * unchanged.
    */
   protected reindent(comment: DocumentComment, targetIndent: string): string {
      if (comment.sourceIndent === undefined || !comment.text.includes('\n')) {
         return comment.text;
      }
      // Indentation is compared as characters, which only means anything while
      // both sides use the SAME whitespace character. A tab-indented source
      // re-emitted with spaces has no meaningful delta, and shifting by one
      // anyway prepends spaces in front of tabs.
      const sourceUnit = /^\t*$/.test(comment.sourceIndent) ? '\t' : ' ';
      const targetUnit = /^\t*$/.test(targetIndent) ? '\t' : ' ';
      const delta = targetIndent.length - comment.sourceIndent.length;
      if (delta === 0 || sourceUnit !== targetUnit) {
         return comment.text;
      }
      const [first, ...rest] = comment.text.split('\n');
      const shifted = rest.map(line => {
         if (delta > 0) {
            return targetUnit.repeat(delta) + line;
         }
         const removable = /^[ \t]*/.exec(line)?.[0].length ?? 0;
         return line.slice(Math.min(-delta, removable));
      });
      return [first, ...shifted].join('\n');
   }

   /** Whether everything from `offset` to the end of its line is whitespace. */
   protected restOfLineIsBlank(text: string, offset: number): boolean {
      return text.slice(offset, this.endOfLineAt(text, offset)).trim().length === 0;
   }

   /** Whether `offset` is preceded on its own line by whitespace alone. */
   protected startOfLineIsBlank(text: string, offset: number): boolean {
      return text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset).trim().length === 0;
   }

   /**
    * End of the line `offset` sits on, as an insertion point for a trailing
    * comment. Stops before a CR so an insertion into CRLF text lands inside the
    * line rather than between its two terminator bytes.
    */
   protected endOfLineAt(text: string, offset: number): number {
      const newline = text.indexOf('\n', offset);
      const lineEnd = newline < 0 ? text.length : newline;
      return lineEnd > 0 && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
   }

   /** Leading whitespace of the line `offset` sits on, so an insertion lines up with it. */
   protected indentAt(text: string, offset: number): string {
      const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
      return /^\s*/.exec(text.slice(lineStart, offset))?.[0] ?? '';
   }

   /**
    * Where every node landed in the serializer's output, keyed by
    * {@link anchorKey}.
    *
    * Re-parses `serialized` through the document factory, which does NOT
    * register the result, so this leaves `LangiumDocuments` alone. Output the
    * grammar cannot read, by reported error or by a throw from a URI that
    * routes to no services, yields `undefined`: the caller then writes the
    * serializer's text unchanged rather than splicing into text already wrong.
    *
    * **A key claimed by two DIFFERENT nodes is removed, not merged.** A repeated
    * identity is exactly what the integrity tier exists to repair, so collisions
    * reach this method routinely; merging their spans puts every one of their
    * comments on whichever came first. Removing the key drops those instead,
    * which is the only outcome here that keeps a comment off a declaration its
    * author did not write it on.
    */
   protected locate(serialized: string, uri: URI): Map<string, AnchorSpan> | undefined {
      const document = this.parse(serialized, uri);
      if (document === undefined) {
         this.tracer.withUri(uri.toString()).warn('Serialized output did not re-parse; writing it without comments');
         return undefined;
      }
      const root = document.parseResult.value.$cstNode;
      if (!root) {
         return undefined;
      }
      const found = new Map<string, AnchorSpan>();
      // One AST node owns many CST nodes — its composite plus every token under
      // it — so a repeated key is only a collision when a DIFFERENT node claims
      // it. Tracking the owner is what separates the two.
      const owners = new Map<string, AstNode>();
      const collided = new Set<string>();
      // One AST node owns every CST node beneath it, so this asks for the same
      // key once per token; `cachedAnchorKey` is what keeps the pass from
      // costing nodes x depth.
      const visit = (node: CstNode): void => {
         const key = node.astNode !== undefined && !node.hidden ? this.cachedAnchorKey(node.astNode) : undefined;
         if (key !== undefined) {
            const owner = owners.get(key);
            if (owner === undefined) {
               owners.set(key, node.astNode!);
               found.set(key, { offset: node.offset, end: node.end, owner: node.astNode! });
            } else if (owner === node.astNode) {
               // Widest span per node: its first CST node gives the start, a
               // later token contributing to the same node extends the end.
               const existing = found.get(key)!;
               found.set(key, {
                  offset: Math.min(existing.offset, node.offset),
                  end: Math.max(existing.end, node.end),
                  owner: existing.owner
               });
            } else {
               collided.add(key);
            }
         }
         if (isComposite(node)) {
            node.content.forEach(visit);
         }
      };
      visit(root);
      for (const key of collided) {
         found.delete(key);
      }
      return found;
   }
}

/** Registers {@link CommentPreserver}; bound at `trivia.preservers.comments`. */
export class CommentPreserverContribution implements TriviaContribution {
   constructor(protected readonly services: HydraniumLanguageServices) {}

   registerTriviaPreservers(registry: TriviaRegistry): void {
      registry.register(new CommentPreserver(this.services));
   }
}
