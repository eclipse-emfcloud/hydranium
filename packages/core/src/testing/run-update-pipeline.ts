/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Driver for the structured-write transform chain — the rewrite registry plus
 * the serializer — run the way `ModelService.update` runs it.
 *
 * # Why a driver and not a documented recipe
 *
 * The chain is short enough that a test can chain it by hand, and that is
 * exactly the failure this exists to prevent. A hand-copied chain names each
 * rewrite as a function call, so it is a SNAPSHOT of the registry taken on the
 * day it was written: a newly registered rewrite, a changed priority or a
 * withdrawn one leaves the copy compiling and passing while production runs
 * something else. Nothing fails, because the drift only matters for the
 * fixtures the missing rewrite would have touched — and a test whose fixture it
 * does not touch keeps asserting against a pipeline that stopped existing.
 * Reading the order from the registry is the only version of this that cannot
 * fall behind.
 *
 * # Resolved per URI, not per language handle
 *
 * Both slots are resolved through `ServiceRegistry.getServices(uri)`, which is
 * what `ModelService.serialize` and `ModelService.rewriteModel` do. Taking a
 * language-services handle instead would be shorter, but it re-hardcodes the
 * language at the call site and so cannot witness a multi-grammar workspace
 * routing a write to the wrong language's rewrite set or serializer — the one
 * defect that only shows up when more than one grammar is registered.
 *
 * # Scope: the transform chain, not the document lifecycle
 *
 * This runs rewrite → serialize and stops. It does NOT open the document, push
 * text into the multi-client store, drive a build or return an
 * {@link AstDocument}: those need a live workspace, and a test that wants them
 * should call `ModelService.update` itself rather than a driver standing in for
 * it. What is left is the part with no observable of its own — the text and the
 * rewritten model — which is why it needed lifting.
 *
 * A textual payload is likewise out of scope. `ModelService.modelToText`
 * returns a string payload untouched, so there is no chain to drive and nothing
 * a driver could add.
 */

import type { AstNode } from '@hydranium/langium';
import { UriUtils } from '@hydranium/langium';
import type { TransferElement } from '@hydranium/protocol';
import type { CancellationToken } from 'vscode-languageserver';
import type { ServerSharedServices } from '../langium/module.js';

/** Inputs to {@link runUpdatePipeline}. */
export interface UpdatePipelineArgs<TTransfer extends TransferElement = TransferElement, TAst extends AstNode = AstNode> {
   /**
    * URI the write is for. Selects the language whose rewrite set and
    * serializer run, so in a multi-grammar workspace it decides the answer
    * rather than merely labelling it.
    */
   readonly uri: string;
   /** Transfer-model payload, as an adopter caller would hand it to `ModelService.update`. */
   readonly model: TTransfer;
   /**
    * Previous AST root threaded into every rewrite, so a diff-based rewrite can
    * tell a real user change from a stale echo.
    *
    * Omit it to take the same value production takes — the current document's
    * `parseResult.value`, or `undefined` for a document that has never been
    * built. Pass it explicitly when the test constructs both sides itself and
    * has no built document to read from.
    */
   readonly previous?: TAst;
   /** Honoured between rewrites, as `UpdateRewriteService.apply` honours it. */
   readonly cancelToken?: CancellationToken;
}

/** What {@link runUpdatePipeline} produced, at both stages. */
export interface UpdatePipelineResult<TTransfer extends TransferElement = TransferElement> {
   /**
    * The model after the rewrite chain and before serialisation.
    *
    * Exposed rather than discarded because the chain is what drifts, and a test
    * that can only see `text` has to assert the chain's effect THROUGH the
    * serializer — which turns a model assertion into a substring match on the
    * concrete syntax, sensitive to formatting that has nothing to do with the
    * rewrite. Returning a bare string was the alternative; it is a smaller
    * surface but it makes the precise assertion unavailable.
    */
   readonly rewritten: TTransfer;
   /** The serialized text, which is what `ModelService.update` applies to the store. */
   readonly text: string;
}

/**
 * Run the rewrite chain registered for `args.uri`'s language, then serialise
 * the result with that language's `Serializer`.
 *
 * Both slots are read from the registry at call time, so a rewrite registered
 * after this driver was written still runs.
 */
export async function runUpdatePipeline<TTransfer extends TransferElement = TransferElement, TAst extends AstNode = AstNode>(
   services: ServerSharedServices,
   args: UpdatePipelineArgs<TTransfer, TAst>
): Promise<UpdatePipelineResult<TTransfer>> {
   const languageServices = services.ServiceRegistry.getServices(UriUtils.toUri(args.uri));
   const previous = args.previous ?? (services.workspace.AstDocumentManager.getDocument(args.uri)?.parseResult.value as TAst | undefined);
   const rewritten = (await languageServices.updateRewrite.UpdateRewriteService.apply(args.model, previous, args.cancelToken)) as TTransfer;
   const text = await languageServices.serializer.Serializer.serializeTransfer(rewritten);
   return { rewritten, text };
}
