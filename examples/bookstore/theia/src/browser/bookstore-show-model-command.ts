/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// `Bookstore: Show Model`: the current editor's file, text or diagram, read
// through the data head, and its root type shown in a notification.

import { Command, type CommandContribution, type CommandRegistry, MessageService, nls } from '@theia/core';
import { ApplicationShell, NavigatableWidget } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ALL_LANGUAGES } from '@hydranium/bookstore-protocol';
import { BookstoreDataConnection } from './bookstore-data-connection.js';

export const SHOW_MODEL_COMMAND = Command.toLocalizedCommand(
   { id: 'bookstore.showModel', label: 'Show Model', category: 'Bookstore' },
   'bookstore/showModel',
   'bookstore/category'
);

@injectable()
export class BookstoreShowModelCommand implements CommandContribution {
   @inject(BookstoreDataConnection) protected readonly connection: BookstoreDataConnection;
   @inject(ApplicationShell) protected readonly shell: ApplicationShell;
   @inject(MessageService) protected readonly messages: MessageService;

   // Opened on the first run and kept: the connection ends it with the page.
   protected session?: ReturnType<BookstoreDataConnection['createSession']>;

   registerCommands(registry: CommandRegistry): void {
      registry.registerCommand(SHOW_MODEL_COMMAND, { execute: () => this.showModel() });
   }

   protected async showModel(): Promise<void> {
      // The main area's, so focus in a side panel such as the Explorer still finds the editor.
      const widget = this.shell.getCurrentWidget('main');
      const uri = NavigatableWidget.is(widget) ? widget.getResourceUri() : undefined;
      if (
         uri === undefined ||
         !ALL_LANGUAGES.some(language => language.fileExtensions.some(extension => uri.path.base.endsWith(extension)))
      ) {
         this.messages.info(nls.localize('bookstore/showModel/noFile', 'Open a Bookstore file first.'));
         return;
      }
      this.session ??= this.connection.createSession('bookstore-show-model');
      const root = await this.session.withOpenDocument({ uri: uri.toString() }, document => document.model?.root.$type);
      this.messages.info(
         nls.localize(
            'bookstore/showModel/holds',
            '{0} holds a {1}',
            uri.path.base,
            root ?? nls.localize('bookstore/showModel/noModel', 'document with no model')
         )
      );
   }
}
