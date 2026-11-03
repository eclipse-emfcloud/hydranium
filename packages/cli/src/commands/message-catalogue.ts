/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { collectMessages, type MessageCatalogue } from '@hydranium/protocol';
import { resolve as resolveModule } from 'import-meta-resolve';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emitReport } from './headless-harness.js';

/**
 * Enumerate declarations rather than scanning source. Conflicting defaults
 * must fail before any output is written, or import order chooses the English.
 */
export function createMessageCatalogue(barrels: readonly object[]): MessageCatalogue {
   const entries = new Map<string, string>();
   for (const barrel of barrels) {
      for (const message of collectMessages(barrel)) {
         const previous = entries.get(message.code);
         if (previous !== undefined && previous !== message.text) {
            throw new Error(`Conflicting English defaults for message '${message.code}'.`);
         }
         entries.set(message.code, message.text);
      }
   }
   return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface MessageCatalogueCommandOptions {
   readonly barrels: readonly string[];
   readonly outFile?: string;
}

/** Resolve against the caller's project, including when the CLI is installed globally. */
export async function runMessageCatalogue(options: MessageCatalogueCommandOptions): Promise<void> {
   const projectUrl = pathToFileURL(resolve('package.json')).href;
   const barrels: object[] = [];
   for (const specifier of options.barrels) {
      const target =
         specifier.startsWith('.') || isAbsolute(specifier) ? pathToFileURL(resolve(specifier)).href : resolveModule(specifier, projectUrl);
      const barrel = (await import(target)) as object;
      if (collectMessages(barrel).length === 0) {
         throw new Error(`Message barrel '${specifier}' exports no declarations. Pass a built messages module.`);
      }
      barrels.push(barrel);
   }
   if (barrels.length === 0) {
      throw new Error('Pass at least one --barrel messages module.');
   }
   emitReport(JSON.stringify(createMessageCatalogue(barrels), undefined, 2), options.outFile);
}
