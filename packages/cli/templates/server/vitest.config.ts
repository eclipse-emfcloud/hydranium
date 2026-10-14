import { defineConfig } from 'vitest/config';

// Vitest transforms TypeScript itself and resolves `.js` specifiers to their
// `.ts` source, so tests import from `../src/` with the same specifiers the
// compiled output uses. `include` is scoped to `test/` so `lib/` is never
// scanned; `npm test` runs `typecheck:test` first, because vitest's
// transform strips types without checking them.

export default defineConfig({
   test: {
      environment: 'node',
      include: ['test/**/*.{test,spec}.ts']
   }
});
