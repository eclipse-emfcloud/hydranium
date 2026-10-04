/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AnyObject, Command, CompoundCommand, type MaybePromise } from '@eclipse-glsp/server';
import {
   type AstNode,
   type AstNodeDescription,
   AstUtils,
   type GenericAstNode,
   isMultiReference,
   type LinkingError,
   type MultiReference,
   type MultiReferenceItem,
   type Reference
} from '@hydranium/langium';
import { type ModelVersion } from '@hydranium/protocol';
import { type HydraniumGlspRecordingState } from './hydranium-glsp-recording-command.js';

/**
 * What becomes of an operation {@link HydraniumGlspOperationCommand} ran: its
 * command written, its write dropped, or no command.
 */
export type OperationOutcome = 'executed' | 'dropped' | 'none';

/**
 * One executed side effect the operation undoes and redoes: a recording
 * command's bridge, or a command that does not record.
 */
export interface SideEffectStep {
   undo(): MaybePromise<void>;
   redo(): MaybePromise<void>;
}

/**
 * The members of an operation the framework's state, recording command and
 * operation action handler call; reached through {@link openOperationOf} and
 * {@link runOperation}, not through the operation itself.
 */
export interface OperationInternals {
   run(create: () => MaybePromise<Command | undefined>): Promise<OperationOutcome>;
   workingRootOf(key: string, built: AstNode): AstNode;
   existingWorkingRootOf(key: string): AstNode | undefined;
   workingUriOf(node: AstNode): string | undefined;
   builtNodeOf<T extends AstNode>(node: T): T;
   recordWrittenRoot(root: AstNode): void;
   recordDropped(current: AstNode | undefined): void;
   recordExecuted(step: SideEffectStep): void;
   assertRecording(label: string): void;
   amendBefore(update: (before: AnyObject) => AnyObject): void;
}

const internals = new WeakMap<object, OperationInternals>();
/** The canonical URI of every working root an operation made, by root. */
const workingRootUris = new WeakMap<AstNode, string>();

/**
 * The canonical URI of the document whose working copy `node` belongs to;
 * `undefined` for a node of no copy. A copy has no `$document`, so a lookup
 * that routes by a node's document routes a copy node through this instead.
 */
export function workingUriOfCopy(node: AstNode): string | undefined {
   return workingRootUris.get(AstUtils.findRootNode(node));
}
const openOperations = new WeakMap<object, OperationInternals>();

/** The operation open on `state`, executing or replaying its side effects; `undefined` between operations. */
export function openOperationOf(state: object): OperationInternals | undefined {
   return openOperations.get(state);
}

/** Run `operation` as {@link HydraniumGlspOperationCommand} describes. */
export function runOperation<TSourceModel extends AnyObject>(
   operation: HydraniumGlspOperationCommand<TSourceModel>,
   create: () => MaybePromise<Command | undefined>
): Promise<OperationOutcome> {
   return membersOf(operation).run(create);
}

function membersOf(operation: object): OperationInternals {
   const members = internals.get(operation);
   if (!members) {
      throw new Error('Not a HydraniumGlspOperationCommand');
   }
   return members;
}

/**
 * One GLSP operation as a transaction, and the command-stack entry that undoes
 * and redoes it.
 *
 * {@link runOperation} executes the operation's command against copies of the
 * built roots and writes their projection once; a reader of a built root never
 * sees an edit its write has not committed, and an edit the write drops stays
 * out of every built root. Call it inside `runExclusive`: the copies, the write
 * and the capture that follows assume no other operation, undo or storage
 * capture runs meanwhile.
 *
 * The entry holds one model transition, from the copies' projection before the
 * command to their projection after it, and the side effects that executed, in
 * order: each command that does not record, a `CompoundCommand`'s children
 * counted one by one, and the bridge of each recording command at any depth.
 * Rollback and undo run them in reverse, redo in order. A recording command
 * executed inside an open operation writes nothing, and its own undo and redo
 * do nothing there.
 */
export class HydraniumGlspOperationCommand<TSourceModel extends AnyObject = AnyObject> implements Command {
   /** Working copies by canonical URI. */
   protected readonly workingRoots = new Map<string, AstNode>();
   /** Built node to copy and copy to built node, across every working root, as `AstUtils.copyAstNode` records it. */
   protected readonly trace = new Map<AstNode, AstNode>();
   /** The source root captured when the operation opened. */
   protected sourceRootAtOpen?: AstNode;
   /** The version of {@link sourceRootAtOpen}, which the write is gated on. */
   protected baseVersionAtOpen?: ModelVersion;
   /**
    * The primary root to capture when the operation closes: the one its write
    * produced, or the current one after a dropped write.
    */
   protected writtenRoot?: AstNode;
   /** Whether the write's reconcile dropped the edit. */
   protected dropped = false;
   /** The command the operation executed. */
   protected command?: Command;
   /** The side effects that executed, in execution order. */
   protected readonly steps: Array<{ undo(): MaybePromise<void>; redo(): MaybePromise<void> }> = [];
   /**
    * The copies' projection when the operation opened, amended as documents
    * join or leave the write set during it.
    */
   protected before?: TSourceModel;
   protected transition?: { readonly from: TSourceModel; readonly to: TSourceModel };
   /** Whether an undo or redo is running the side effects, on copies it discards. */
   protected replaying = false;

   constructor(protected readonly modelState: HydraniumGlspRecordingState<TSourceModel>) {
      const members: OperationInternals = {
         run: create => this.run(create),
         workingRootOf: (key, built) => this.workingRootOf(key, built),
         existingWorkingRootOf: key => this.workingRoots.get(key),
         workingUriOf: node => this.workingUriOf(node),
         builtNodeOf: node => this.builtNodeOf(node),
         recordWrittenRoot: root => {
            this.writtenRoot = root;
         },
         recordDropped: current => {
            this.dropped = true;
            this.writtenRoot = current;
         },
         recordExecuted: step => {
            this.steps.push(step);
         },
         amendBefore: update => {
            if (this.before !== undefined) {
               this.before = update(this.before) as TSourceModel;
            }
         },
         assertRecording: label => {
            if (this.replaying) {
               throw new Error(
                  `Recording command '${label}' executed during an undo or redo: a replay writes only the recorded transition, ` +
                     'so its edit would be discarded. Execute it in an operation of its own.'
               );
            }
         }
      };
      internals.set(this, members);
   }

   /**
    * Open the operation, execute the command `create` makes, write the result
    * once, and close the operation.
    *
    * `create` runs inside the operation, because handlers resolve their
    * targets there. On any failure, `create`, the command or the write, the
    * executed commands' side effects are undone, nothing is written, and the
    * error is rethrown; after a write whose reconcile dropped the edit, the
    * side effects are undone the same way and this answers `'dropped'`. The
    * operation closes either way: the copies are dropped and the source root
    * is captured again, with the base version, every tracked version and the
    * index.
    */
   protected async run(create: () => MaybePromise<Command | undefined>): Promise<'executed' | 'dropped' | 'none'> {
      this.open();
      try {
         this.before = await this.project();
         await this.checkpoint('create');
         const command = await create();
         if (!command) {
            return 'none';
         }
         await this.tracked(command).execute();
         this.command = command;
         await this.checkpoint('project');
         const written = await this.project();
         if (written !== undefined && !(await this.write(written))) {
            await this.rollback();
            return 'dropped';
         }
         if (this.before !== undefined && written !== undefined) {
            this.transition = { from: this.before, to: written };
         }
         return 'executed';
      } catch (error: unknown) {
         await this.rollback();
         throw error;
      } finally {
         this.close();
      }
   }

   /**
    * Awaited where the operation, or an undo or redo of it, yields to code it
    * does not control: before creating the command, before each side effect
    * executes, replays, rolls back or is compensated, before projecting the
    * copies, before resolving a replay. Does nothing; a test overrides it to
    * land a foreign edit or a failure there.
    */
   protected async checkpoint(
      _point: 'create' | 'execute' | 'project' | 'resolve' | 'undo' | 'redo' | 'rollback' | 'compensate'
   ): Promise<void> {
      // A seam for tests.
   }

   /**
    * Does nothing: {@link runOperation} executed the command; the command stack
    * calls this when it pushes the entry.
    */
   async execute(): Promise<void> {
      // Executed by runOperation().
   }

   async undo(): Promise<void> {
      await this.replay('undo');
   }

   async redo(): Promise<void> {
      await this.replay('redo');
   }

   canUndo(): boolean {
      return this.command?.canUndo?.() ?? true;
   }

   /** The working copy of `built`, the root of the document whose canonical URI is `key`, made on the first request. */
   protected workingRootOf(key: string, built: AstNode): AstNode {
      let working = this.workingRoots.get(key);
      if (!working) {
         working = AstUtils.copyAstNode(
            built,
            (_node, _property, _refNode, _refText, original) => this.buildWorkingReference(original),
            this.trace
         );
         this.rebuildWorkingMultiReferences(working);
         this.workingRoots.set(key, working);
         workingRootUris.set(working, key);
         this.modelState.index.remapSemanticAliases(node =>
            AstUtils.findRootNode(node) === built ? (this.trace.get(node) ?? node) : node
         );
      }
      return working;
   }

   /** The canonical URI of the working root `node` belongs to; `undefined` for a node of no copy. */
   protected workingUriOf(node: AstNode): string | undefined {
      const root = AstUtils.findRootNode(node);
      for (const [key, working] of this.workingRoots) {
         if (working === root) {
            return key;
         }
      }
      return undefined;
   }

   /**
    * The built node `node` was copied from; `node` itself for a node of no copy
    * and for a node the operation created.
    */
   protected builtNodeOf<T extends AstNode>(node: T): T {
      if (this.workingUriOf(node) === undefined) {
         return node;
      }
      const built = this.trace.get(node);
      return built === undefined ? node : (built as T);
   }

   /**
    * Copy the source root, and point the index at the copy, so the nodes a
    * handler resolves by id are the nodes it edits.
    */
   protected open(): void {
      this.sourceRootAtOpen = this.modelState.sourceRoot;
      this.baseVersionAtOpen = this.modelState.baseVersion;
      openOperations.set(this.modelState, membersOf(this));
      if (this.sourceRootAtOpen !== undefined) {
         this.modelState.index.reindexSemanticElements(this.modelState.sourceRoot, this.modelState.sourceUri);
      }
   }

   /**
    * Drop the copies, move every id added through `indexSemanticElement` from
    * a copy back to the built node it was copied from, and capture the source
    * root again, whether or not the write changed it.
    */
   protected close(): void {
      const copies = new Set(this.workingRoots.values());
      this.modelState.index.remapSemanticAliases(node => (copies.has(AstUtils.findRootNode(node)) ? this.trace.get(node) : node));
      openOperations.delete(this.modelState);
      const root = this.writtenRoot ?? this.sourceRootAtOpen;
      if (root !== undefined) {
         this.modelState.setSourceRoot(this.modelState.sourceUri, root);
      }
   }

   /**
    * Undo the side effects of the executed commands, newest first, each step
    * on its own: a step that fails is logged and the rest are still undone.
    * The operation's own error is the one thrown.
    */
   protected async rollback(): Promise<void> {
      await this.runEach(
         [...this.steps].reverse().map(step => () => step.undo()),
         'Rolling back a failed operation',
         'rollback'
      );
   }

   /**
    * Run each of `actions`, each reverting a side effect of its own: a failure
    * is logged as `what` failing and the rest still run, so one step that
    * cannot be reverted leaves no other step applied. The caller reports its
    * own failure, not these.
    */
   protected async runEach(
      actions: ReadonlyArray<() => MaybePromise<void>>,
      what: string,
      point: 'rollback' | 'compensate'
   ): Promise<void> {
      for (const action of actions) {
         try {
            await this.checkpoint(point);
            await action();
         } catch (error: unknown) {
            this.modelState.logger.error(`${what} failed at one step: ${error instanceof Error ? error.message : String(error)}`);
         }
      }
   }

   /**
    * `command` with every side effect it executes recorded as a step: the
    * command itself, or for a `CompoundCommand` each child, at any depth. A
    * tracked command's own undo and redo do nothing, so a `CompoundCommand`
    * reverting its children when a later one throws leaves that to the steps.
    *
    * The children are read from GLSP's protected `CompoundCommand.commands`;
    * should that field stop being readable, a compound becomes one step and
    * its children's side effects no longer interleave with the bridges.
    */
   protected tracked(command: Command): Command {
      const children: unknown = command instanceof CompoundCommand ? Reflect.get(command, 'commands') : undefined;
      if (isCommandArray(children)) {
         children.forEach((child, i) => {
            children[i] = this.tracked(child);
         });
         return command;
      }
      return {
         execute: async () => {
            await this.checkpoint('execute');
            await command.execute();
            this.steps.push({ undo: () => command.undo(), redo: () => command.redo() });
         },
         undo: () => undefined,
         redo: () => undefined,
         canUndo: () => Command.canUndo(command)
      };
   }

   /** The model projected from the working copies, cloned; `undefined` for a state that projects none. */
   protected async project(): Promise<TSourceModel | undefined> {
      const model: TSourceModel | undefined = await this.modelState.sourceModel;
      return model === undefined ? undefined : structuredClone(model);
   }

   /**
    * Resolve the transition onto the current model, run the commands' side
    * effects, then write once, gated on the versions the model was read at. A
    * collision does nothing but warn; a transition with nothing left to replay
    * still runs the side effects.
    *
    * The caller holds `runExclusive`, which nothing here takes again.
    */
   protected async replay(direction: 'undo' | 'redo'): Promise<void> {
      // Captured again so the model the transition is resolved onto, the base
      // a conflict reconciles from and the versions the write is gated on are
      // read together.
      if (this.modelState.sourceRoot !== undefined) {
         this.modelState.setSourceRoot(this.modelState.sourceUri, this.modelState.sourceRoot);
      }
      await this.checkpoint('resolve');
      let merged: TSourceModel | undefined;
      if (this.transition) {
         const { from, to } = direction === 'undo' ? { from: this.transition.to, to: this.transition.from } : this.transition;
         const outcome = await this.modelState.conflictResolver.resolve<TSourceModel>(from, to, async () => this.modelState.sourceModel);
         if (outcome.status === 'merged') {
            merged = outcome.merged;
         } else if (outcome.status !== 'no-op') {
            this.modelState.logger.warn(
               `${direction === 'undo' ? 'Undo' : 'Redo'} of an operation skipped (${outcome.status}); a foreign edit changed a shared field`
            );
            return;
         }
      }
      await this.replaySideEffects(direction, merged);
   }

   /**
    * Write `model` once through the state's write path, gated on the versions
    * read when the operation opened, a conflict reconciled as for any write of
    * the state; `false` when the reconcile dropped it.
    */
   protected async write(model: TSourceModel): Promise<boolean> {
      this.dropped = false;
      await this.modelState.updateSourceModel(model, this.baseVersionAtOpen);
      return !this.dropped;
   }

   /**
    * Run the recorded steps of an undo or redo against fresh copies of the
    * built roots, made on demand as in an operation and discarded unwritten,
    * then write `merged`, the resolved transition, through {@link write}: that
    * write is what changes the model, and a step that edits `sourceRoot` must
    * not reach the root every reader shares. A recording command executed here
    * throws.
    *
    * When a step or the write throws, or the write's reconcile drops it, the
    * steps already run are run the other way, newest first, and the error is
    * rethrown with nothing written; GLSP's command stack then flushes, as it
    * does for any undo or redo that fails.
    */
   protected async replaySideEffects(direction: 'undo' | 'redo', merged?: TSourceModel): Promise<void> {
      this.workingRoots.clear();
      this.trace.clear();
      this.writtenRoot = undefined;
      this.replaying = true;
      this.open();
      const steps = direction === 'undo' ? [...this.steps].reverse() : [...this.steps];
      const done: typeof steps = [];
      try {
         for (const step of steps) {
            await this.checkpoint(direction);
            await (direction === 'undo' ? step.undo() : step.redo());
            done.unshift(step);
         }
         if (merged !== undefined && !(await this.write(merged))) {
            throw new Error(`The ${direction} of an operation was dropped: a foreign edit changed a field it writes`);
         }
      } catch (error: unknown) {
         await this.compensate(done, direction);
         throw error;
      } finally {
         this.close();
         this.replaying = false;
      }
   }

   /**
    * Run `steps`, which a failed replay in `direction` already ran, the other
    * way, each on its own as {@link rollback} does; the replay's own error is
    * the one thrown.
    */
   protected async compensate(
      steps: ReadonlyArray<{ undo(): MaybePromise<void>; redo(): MaybePromise<void> }>,
      direction: 'undo' | 'redo'
   ): Promise<void> {
      await this.runEach(
         steps.map(step => () => (direction === 'undo' ? step.redo() : step.undo())),
         `Reverting a failed ${direction}`,
         'compensate'
      );
   }

   /**
    * The copy's stand-in for `original`: its target is the copy of
    * `original`'s target once one exists, read when asked so a copy made later
    * in the operation is found, else that target itself. A handler compares a
    * target by identity with nodes it resolved from a copy.
    */
   protected buildWorkingReference(original: Reference): Reference {
      const trace = this.trace;
      return {
         $refText: original.$refText,
         $refNode: original.$refNode,
         get ref(): AstNode | undefined {
            const target = original.ref;
            return target && (trace.get(target) ?? target);
         },
         get error(): LinkingError | undefined {
            return original.error;
         },
         get $nodeDescription(): AstNodeDescription | undefined {
            return original.$nodeDescription;
         }
      };
   }

   /** {@link buildWorkingReference} for a reference with several targets. */
   protected buildWorkingMultiReference(original: MultiReference): MultiReference {
      const trace = this.trace;
      return {
         $refText: original.$refText,
         $refNode: original.$refNode,
         get items(): MultiReferenceItem[] {
            return original.items.map(item => ({ ref: trace.get(item.ref) ?? item.ref, $nodeDescription: item.$nodeDescription }));
         },
         get error(): LinkingError | undefined {
            return original.error;
         }
      };
   }

   /**
    * Replace every multi-reference under `working` with a working one.
    * `AstUtils.copyAstNode` rebuilds single references only and leaves a
    * multi-reference object shared with the built root, whose targets are
    * built nodes.
    */
   protected rebuildWorkingMultiReferences(working: AstNode): void {
      for (const node of AstUtils.streamAst(working)) {
         const properties = node as GenericAstNode;
         for (const [name, value] of Object.entries(properties)) {
            if (name.startsWith('$')) {
               continue;
            }
            if (isMultiReference(value)) {
               properties[name] = this.buildWorkingMultiReference(value);
            } else if (Array.isArray(value) && value.some(element => isMultiReference(element))) {
               properties[name] = value.map((element: unknown) =>
                  isMultiReference(element) ? this.buildWorkingMultiReference(element) : element
               );
            }
         }
      }
   }
}

function isCommandArray(value: unknown): value is Command[] {
   return Array.isArray(value) && value.every(element => typeof element === 'object' && element !== null && 'execute' in element);
}
