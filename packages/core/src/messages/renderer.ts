/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   describeError,
   renderFrameworkMessage,
   resolve,
   resolvedFromResponseError,
   type MessageDefinition,
   type ParamsArg,
   type ResolvedMessage,
   type Tracer
} from '@hydranium/protocol';
import { SimpleCache } from '@hydranium/langium';
import type { ResponseError } from 'vscode-jsonrpc';
import { Diagnostic } from 'vscode-languageserver-protocol';
import { type LogNameOptions } from '../langium/diagnostics/logger.js';
import type { ServerSharedServicesMinimal } from '../langium/shared-services.js';
import type { ServerLocale } from '../locale/server-locale.js';
import { resolvedFromDiagnostic } from './carriers.js';

/** Construction options for {@link ServerMessageRenderer}. */
export type ServerMessageRendererOptions = LogNameOptions;

/**
 * Renders every user-facing message the server sends, in the locale the server
 * was handed at init. The framework ships no catalogue, so its own behaviour is
 * a pass-through.
 *
 * Adopters override {@link translationsFor}: the public render methods carry
 * the no-throw contract, and the catalogue lookup they wrap is what can fail.
 *
 * Two render methods rather than one, because what is useful to an adopter is
 * the carrier's structured fields and the two carriers have different ones. A
 * single `render(text)` would force an adopter to match English prose, which
 * breaks on the first Langium reword.
 */
export class ServerMessageRenderer {
   protected readonly tracer: Tracer;
   protected readonly serverLocale: ServerLocale;
   /**
    * {@link translationsFor}'s answer per locale, `undefined` answers included —
    * a `SimpleCache` distinguishes "absent" from "cached as none", which matters
    * because shipping no catalogue is the framework's own hot path.
    *
    * `SimpleCache` rather than Langium's `WorkspaceCache`: the eviction axis
    * there is document change, and a catalogue does not depend on documents, so
    * it would evict on every build AND put a `DocumentBuilder` dependency on a
    * service the shared tier declares free of one. Nothing evicts this: the
    * locale arrives once per process. A subclass whose catalogue can change
    * clears it.
    */
   protected readonly catalogues = new SimpleCache<string | undefined, Record<string, string> | undefined>();

   constructor(services: ServerSharedServicesMinimal, options: ServerMessageRendererOptions = {}) {
      this.serverLocale = services.ServerLocale;
      this.tracer = services.Tracer.for(options.logName ?? 'MessageRenderer').trace('instantiated');
   }

   /**
    * The sentence to publish for `diagnostic`, replacing its current `message`.
    * Sees lexer and parser errors too, which Langium pushes onto the document
    * without routing them through `toDiagnostic`.
    *
    * **Must not throw**, which is why the guard is here and not at the call
    * site: this runs inside the `Validated` phase, and Langium's
    * `notifyDocumentPhase` rethrows anything that is not a cancellation — so an
    * escaping error leaves the document AT `Validated` with the phase's
    * listeners never run, and the client receives no diagnostics for that file.
    * A subclass overriding this method takes that contract on itself.
    */
   renderDiagnostic(diagnostic: Diagnostic): string {
      try {
         const resolved = resolvedFromDiagnostic(diagnostic);
         return resolved ? this.render(resolved) : Diagnostic.getMessageString(diagnostic);
      } catch (err: unknown) {
         this.reportFailure(err, 'a diagnostic');
         return Diagnostic.getMessageString(diagnostic);
      }
   }

   /**
    * The sentence to send for `error`, replacing its current `message`. Same
    * no-throw contract as {@link renderDiagnostic}: an escaping error replaces a
    * typed rejection the caller can handle with one it cannot.
    */
   renderError(error: ResponseError<unknown>): string {
      try {
         const resolved = resolvedFromResponseError(error);
         return resolved ? this.render(resolved) : error.message;
      } catch (err: unknown) {
         this.reportFailure(err, 'an RPC error');
         return error.message;
      }
   }

   /**
    * The sentence for a declaration the caller holds directly, for a carrier
    * with no slot to put an identity in.
    *
    * GLSP's action protocol is the case: every member of its message, status
    * and reject actions is prose or an enum, so a code cannot travel and the
    * raise site is the last place that still knows which message this is.
    * Prefer {@link renderDiagnostic} / {@link renderError} wherever a carrier
    * does hold the identity — they keep the render off the raise site, so an
    * adopter's own messages ride the same one binding.
    *
    * Same no-throw contract as the carrier methods.
    */
   renderMessage<S extends string>(message: MessageDefinition<S>, ...params: ParamsArg<S>): string {
      // `resolve` is inside the guard with the render, not before it: it calls
      // the declaration's own `format`, which for an adopter declaration is
      // arbitrary code, and a throw there would escape a method whose contract
      // says it cannot.
      let resolved: ResolvedMessage | undefined;
      try {
         resolved = resolve(message, ...params);
         return this.render(resolved);
      } catch (err: unknown) {
         this.reportFailure(err, `the message '${message.code}'`);
         // Unset only when `format` ITSELF threw, which leaves the
         // uninterpolated template as the only text there is. A failed render
         // still has the resolved English.
         return resolved?.text ?? message.text;
      }
   }

   /**
    * The catalogue for the current locale, or `undefined` for none — the
    * framework's answer, shipping none. Overriding this leaves every identity
    * decision, every pass-through and the no-throw guard in place.
    *
    * **Called once per locale, not once per message**, so an override may load
    * a file or build a map without that cost landing per diagnostic. The
    * corollary is that a catalogue mutated in place afterwards is not seen;
    * clear {@link catalogues} to invalidate.
    *
    * An adopter wanting Langium's own uncoded sentences instead matches
    * `Diagnostic.data.code` from an overridden {@link renderDiagnostic}, never
    * the sentence.
    */
   protected translationsFor(_locale: string | undefined): Record<string, string> | undefined {
      return undefined;
   }

   /**
    * Resolve one identity against the current locale's catalogue.
    *
    * Reads the locale per call. Copying it into a field at construction pins
    * whatever was there before init ran, which is always `undefined` — services
    * compose first.
    *
    * The catalogue behind it is memoized, because a workspace-wide validation
    * renders once per diagnostic and the naive override — parse a JSON file,
    * build a map — then pays that per diagnostic rather than per locale.
    */
   protected render(message: ResolvedMessage): string {
      const locale = this.serverLocale.value;
      return renderFrameworkMessage(
         message,
         this.catalogues.get(locale, () => this.translationsFor(locale))
      );
   }

   /**
    * Emit a failed render. Logged rather than swallowed: the fallback output is
    * byte-identical to a correctly-configured default, so a throwing catalogue
    * is otherwise invisible.
    */
   protected reportFailure(err: unknown, carrier: string): void {
      this.tracer.error(this.formatRenderFailure(err, carrier));
   }

   /** Format the failed-render line. Override to name the adopter's catalogue entry. */
   protected formatRenderFailure(err: unknown, carrier: string): string {
      return `rendering ${carrier} failed; falling back to the server's own text. ${describeError(err)}`;
   }
}
