// The data part of the page: one document read through the data head, out of
// the same store the other heads serve.

import { DataConnectionWithEvents, type DataPort } from '@hydranium/protocol';
import type { __NAME__Element } from '__PROTOCOL_PACKAGE__';

/** Open `uri` through the data head and say what it holds on the status line below the panes. */
export async function showDataStatus(port: DataPort, uri: string): Promise<void> {
   const session = new DataConnectionWithEvents<__NAME__Element>(port).createSession('__PROJECT_ID__-page');
   const opened = await session.openDocument({ uri });
   const line = document.getElementById('data-status') as HTMLElement;
   const file = uri.slice(uri.lastIndexOf('/') + 1);
   line.textContent = `data head: ${file} holds a ${opened.model?.root.$type ?? 'document with no model'}`;
   line.hidden = false;
}
