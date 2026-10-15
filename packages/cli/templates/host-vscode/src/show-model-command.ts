// `__NAME__: Show Model`: the active tab's file, text or diagram, read through
// the data head, and its root type shown in a notification.

import type { DataConnectionWithEvents } from '@hydranium/protocol';
import { ALL_LANGUAGES, type __NAME__Element } from '__PROTOCOL_PACKAGE__';
import { TabInputCustom, TabInputText, window } from 'vscode';

/** The command's handler, reading through `connection`. */
export function showModelCommand(connection: DataConnectionWithEvents<__NAME__Element>): () => Promise<void> {
   // Opened on the first run and kept until the connection is disposed.
   let session: ReturnType<typeof connection.createSession> | undefined;
   return async () => {
      const input = window.tabGroups.activeTabGroup.activeTab?.input;
      const uri = input instanceof TabInputText || input instanceof TabInputCustom ? input.uri : undefined;
      if (uri === undefined || !ALL_LANGUAGES.some(language => language.fileExtensions.some(extension => uri.path.endsWith(extension)))) {
         void window.showInformationMessage('Open a __NAME__ file first.');
         return;
      }
      session ??= connection.createSession('__PROJECT_ID__-show-model');
      const root = await session.withOpenDocument({ uri: uri.toString() }, document => document.model?.root.$type);
      const file = uri.path.slice(uri.path.lastIndexOf('/') + 1);
      void window.showInformationMessage(`${file} holds a ${root ?? 'document with no model'}`);
   };
}
