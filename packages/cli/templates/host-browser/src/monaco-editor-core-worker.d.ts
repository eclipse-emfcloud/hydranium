// `monaco-editor-core` types its editor API only, so the worker entry
// `monaco-editor-worker.ts` imports is declared here.

declare module 'monaco-editor-core/esm/vs/editor/editor.worker.start.js' {
   /** Start the editor worker's dispatcher, with `createClient`'s result answering requests of the embedder's own. */
   export function start(createClient: () => object): void;
}
