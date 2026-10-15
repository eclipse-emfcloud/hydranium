// The file the page shows: the switch above the panes, between the workspace
// files the worker holds. Each part follows it, and any part can switch it, so
// a page with one part fewer still has it.

import type { WorkerHeads } from '@hydranium/client-browser';
import { WORKSPACE_ROOT_URI } from './workspace.js';

/** The file the page shows, for each part that follows it. */
export interface ShownFile {
   /** Each workspace file a language claims, by URI, with the text the worker holds. */
   readonly files: ReadonlyMap<string, string>;
   /** The URI of the file shown now. */
   current(): string;
   /** Switch the page to `uri`, one of {@link files}. */
   show(uri: string): void;
   /** Call `listener` with the URI of each file the page switches to. */
   onDidChange(listener: (uri: string) => void): void;
}

/**
 * Fill the switch with the files of `languages` the worker sent once its heads
 * were up, and show the first.
 */
export async function startShownFile(
   heads: WorkerHeads,
   languages: ReadonlyArray<{ readonly fileExtensions: readonly string[] }>
): Promise<ShownFile> {
   // The text comes from the worker rather than the seed, since a saved edit
   // is laid over the seed there.
   const { workspace } = await heads.ready;
   if (workspace === undefined) {
      throw new Error('the worker sent no workspace files');
   }
   // Only the files a part of the page can show: one of another language would show nothing.
   const claimed = (path: string): boolean =>
      languages.some(language => language.fileExtensions.some(extension => path.endsWith(extension)));
   const paths = Object.keys(workspace.files).filter(claimed).sort();
   if (paths.length === 0) {
      throw new Error('no workspace file has an extension the page shows');
   }
   const files = new Map(paths.map(path => [`${WORKSPACE_ROOT_URI}/${path}`, workspace.files[path]]));

   const select = document.getElementById('file') as HTMLSelectElement;
   // The worker keys each file by its encoded path, as in its URI: shown decoded.
   select.append(...paths.map(path => new Option(decodeURIComponent(path), `${WORKSPACE_ROOT_URI}/${path}`)));
   let shown = select.value;
   const listeners: Array<(uri: string) => void> = [];
   const show = (uri: string): void => {
      if (!files.has(uri)) {
         throw new Error(`${uri} is not a workspace file the page shows`);
      }
      select.value = uri;
      if (uri !== shown) {
         shown = uri;
         listeners.forEach(listener => listener(uri));
      }
   };
   select.addEventListener('change', () => show(select.value));
   select.hidden = false;
   return { files, current: () => shown, show, onDidChange: listener => listeners.push(listener) };
}
