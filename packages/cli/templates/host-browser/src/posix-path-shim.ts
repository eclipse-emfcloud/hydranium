// The one function of Node's `path` the framework imports, for the bundle to
// resolve: `esbuild.mjs` points the bare `path` specifier here, while a
// `node:path` import still fails the bundle. Only a workspace folder given as
// a filesystem path reaches it, which the page, naming a URI, never does.

/** Resolve `segments` right to left into one absolute path, as `path.posix.resolve` does from `/`. */
export function resolve(...segments: string[]): string {
   let resolved = '';
   for (let i = segments.length - 1; i >= 0 && !resolved.startsWith('/'); i--) {
      if (segments[i].length > 0) {
         resolved = resolved.length === 0 ? segments[i] : `${segments[i]}/${resolved}`;
      }
   }
   const parts: string[] = [];
   for (const part of resolved.split('/')) {
      if (part === '..') {
         parts.pop();
      } else if (part !== '' && part !== '.') {
         parts.push(part);
      }
   }
   return `/${parts.join('/')}`;
}
