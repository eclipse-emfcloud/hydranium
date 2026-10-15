// Monaco's own editor worker, a third worker hosting no head: Monaco runs link
// detection, diffs and minimal edits there. `monaco-editor-core` ships no
// entry for it, so this is one: wait for the first message, then start, which
// replaces this handler with Monaco's own.

import { start } from 'monaco-editor-core/esm/vs/editor/editor.worker.start.js';

self.onmessage = (): void => {
   start(() => ({}));
};
