/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type ConfigurationInitializedParams, DefaultConfigurationProvider } from '@hydranium/langium';
import type { ConfigurationItem, DidChangeConfigurationRegistrationOptions } from 'vscode-languageserver';

/**
 * Configuration provider that asks the client about a section the first time
 * something reads it.
 *
 * Langium's base requests one section per registered language, named after the
 * language id, and never asks again. A read of any other section — including
 * whatever `lsp.configurationRoot` is bound to — then resolves `undefined` with
 * no request on the wire, which is indistinguishable from a setting the user has
 * not set.
 *
 * Asking on first read rather than from a list collected up front: a reader
 * names its section during DI, after `initialized` has taken its one-shot pass,
 * so a list would have to be complete before the server initialized.
 */
export class HydraniumConfigurationProvider extends DefaultConfigurationProvider {
   /**
    * The client-facing hooks, captured because they arrive once as arguments to
    * {@link initialized} and are needed on every later read. Absent in a
    * headless composition, which has no connection to ask.
    */
   protected registerForSection?: (params: DidChangeConfigurationRegistrationOptions) => void;
   protected fetchSections?: (items: ConfigurationItem[]) => Promise<unknown>;

   /**
    * Sections already dealt with, holding the in-flight work so concurrent
    * readers share one round trip. Entries stay after they settle: they record
    * that the section was HANDLED, and without that an unset section is
    * re-requested on every read, "unset" and "not fetched" being the same
    * absence in the store.
    *
    * A section the client's capabilities ruled out counts as handled, having
    * been settled by asking nothing.
    */
   protected readonly requestedSections = new Map<string, Promise<void>>();

   override async initialized(params: ConfigurationInitializedParams): Promise<void> {
      this.registerForSection = params.register;
      this.fetchSections = params.fetchConfiguration;
      await super.initialized(params);
   }

   /**
    * The `ready` await precedes the emptiness check: the base resolves it at the
    * end of its own initial fetch, so testing the store first calls every
    * language section missing and re-requests what is already on its way.
    */
   override async getConfiguration(language: string, configuration: string): Promise<unknown> {
      await this.ready;
      const section = this.toSectionName(language);
      if (this.settings[section] === undefined) {
         await this.requestSection(section);
      }
      return super.getConfiguration(language, configuration);
   }

   /** Ask about `section` once, sharing the request with any concurrent reader. */
   protected requestSection(section: string): Promise<void> {
      const existing = this.requestedSections.get(section);
      if (existing) {
         return existing;
      }
      const request = this.doRequestSection(section);
      this.requestedSections.set(section, request);
      return request;
   }

   /**
    * The hooks are gated on the client having declared `workspace.configuration`.
    * A connection binds them whatever the client said, so their presence is not
    * consent: calling them sends a `client/registerCapability` and a
    * `workspace/configuration` to a client that advertised support for neither,
    * which is entitled to answer either with a method-not-found and may drop the
    * connection.
    *
    * That flag is exact for the fetch and KNOWINGLY coarse for the registration,
    * which the spec governs by
    * `workspace.didChangeConfiguration.dynamicRegistration`. The base registers
    * under `workspace.configuration` alone before any of this runs, so gating
    * the registration on the narrower flag here would withhold a request whose
    * twin has already gone out, sparing the client nothing. A client declaring
    * `workspace.configuration` without dynamic registration is still registered
    * for, by the base and by this; closing that means changing the base's pass,
    * not this gate.
    *
    * Registering before fetching, so an edit landing between the two arrives as
    * a notification instead of being lost; the reverse order drops it.
    *
    * A `null` result is left out of the store rather than written, so the
    * section reads as unset, and no `onConfigurationSectionUpdate` fires — the
    * value goes to the caller that asked for it, and an event would announce a
    * change that is only this provider catching up.
    */
   protected async doRequestSection(section: string): Promise<void> {
      if (!this.workspaceConfig) {
         return;
      }
      this.registerForSection?.({ section });
      if (!this.fetchSections) {
         return;
      }
      const fetched = await this.fetchSections([{ section }]);
      const value = Array.isArray(fetched) ? fetched[0] : fetched;
      if (value !== null && value !== undefined) {
         this.updateSectionConfiguration(section, value);
      }
   }
}
