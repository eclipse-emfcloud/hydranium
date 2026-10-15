// `__NAME__: Show Model`: the current editor's file, text or diagram, read
// through the data head, and its root type shown in a notification.

import { Command, type CommandContribution, type CommandRegistry, MessageService, nls } from '@theia/core';
import { ApplicationShell, NavigatableWidget } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ALL_LANGUAGES } from '__PROTOCOL_PACKAGE__';
import { __NAME__DataConnection } from './__PROJECT_ID__-data-connection.js';

export const SHOW_MODEL_COMMAND = Command.toLocalizedCommand(
   { id: '__PROJECT_ID__.showModel', label: 'Show Model', category: '__NAME__' },
   '__PROJECT_ID__/showModel',
   '__PROJECT_ID__/category'
);

@injectable()
export class __NAME__ShowModelCommand implements CommandContribution {
   @inject(__NAME__DataConnection) protected readonly connection: __NAME__DataConnection;
   @inject(ApplicationShell) protected readonly shell: ApplicationShell;
   @inject(MessageService) protected readonly messages: MessageService;

   // Opened on the first run and kept: the connection ends it with the page.
   protected session?: ReturnType<__NAME__DataConnection['createSession']>;

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
         this.messages.info(nls.localize('__PROJECT_ID__/showModel/noFile', 'Open a __NAME__ file first.'));
         return;
      }
      this.session ??= this.connection.createSession('__PROJECT_ID__-show-model');
      const root = await this.session.withOpenDocument({ uri: uri.toString() }, document => document.model?.root.$type);
      this.messages.info(
         nls.localize(
            '__PROJECT_ID__/showModel/holds',
            '{0} holds a {1}',
            uri.path.base,
            root ?? nls.localize('__PROJECT_ID__/showModel/noModel', 'document with no model')
         )
      );
   }
}
