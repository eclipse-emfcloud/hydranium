/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `init --monorepo` detection rules, over an in-memory tree.
 *
 * A fake filesystem rather than a temp directory because every rule here is
 * about the SHAPE of a repo — a solution-style root tsconfig, siblings that
 * disagree about their scope, a `workspaces` glob that does or does not reach
 * the target — and those shapes are the expensive thing to build on disk and
 * the cheap thing to write down.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
   detectWorkspace,
   findBaseTsconfig,
   findWorkspaceRoot,
   inferPackageScope,
   type JsonValue,
   stripJsonComments,
   type WorkspaceProbe,
   findEslintConfig,
   findPrettierPrintWidth,
   workspaceGlobCovers
} from '../src/commands/init-workspace.js';

const ROOT = path.resolve('/repo');

/** A probe over a literal path → JSON map. Directory listings are derived from the keys. */
function fakeProbe(files: Record<string, JsonValue>): WorkspaceProbe {
   const absolute = new Map(Object.entries(files).map(([relative, content]) => [path.join(ROOT, relative), content]));
   const namesIn = (directory: string, wantDirectory: boolean): string[] => {
      const names = new Set<string>();
      for (const filePath of absolute.keys()) {
         const relative = path.relative(directory, filePath);
         if (relative.startsWith('..') || path.isAbsolute(relative)) {
            continue;
         }
         const segments = relative.split(path.sep);
         if (wantDirectory ? segments.length > 1 : segments.length === 1) {
            names.add(segments[0]);
         }
      }
      return [...names];
   };
   return {
      readJson: filePath => absolute.get(filePath),
      listDirectories: directory => namesIn(directory, true),
      listFiles: directory => namesIn(directory, false),
      // The map holds parsed JSON, so a text read serialises it back. Enough for
      // the JSON-shaped configs; a test needing a JS module's text supplies it as
      // a string value, which stringifies to itself minus the quotes below.
      readText: filePath => {
         const content = absolute.get(filePath);
         return content === undefined ? undefined : typeof content === 'string' ? content : JSON.stringify(content);
      }
   };
}

/** The repo shape the rules were written against: a solution root tsconfig plus a real base. */
const MONOREPO: Record<string, JsonValue> = {
   'package.json': { name: 'hydranium-root', workspaces: ['packages/*', 'examples/order-flow/server'] },
   // `files: []` + `references` — extending this inherits NO compiler options.
   'tsconfig.json': { files: [], references: [{ path: 'packages/core' }] },
   'tsconfig.base.json': { compilerOptions: { strict: true, target: 'ES2022', module: 'CommonJS' } },
   'packages/core/package.json': { name: '@acme/core' },
   'packages/cli/package.json': { name: '@acme/cli' },
   'examples/order-flow/server/package.json': { name: '@acme/example-order-flow-server' }
};

/**
 * `tsc` accepts comments and trailing commas in a config; `JSON.parse` does not.
 * A base config carrying either would otherwise read as "no compilerOptions
 * here" and the scaffold would silently emit no `extends`.
 */
describe('stripJsonComments', () => {
   it('removes line and block comments and a trailing comma', () => {
      const source = `{
  // the base config
  "compilerOptions": {
    /* language level */
    "target": "ES2022",
    "strict": true,
  },
}`;
      expect(JSON.parse(stripJsonComments(source))).toEqual({ compilerOptions: { target: 'ES2022', strict: true } });
   });

   /** The case a naive regex corrupts: both constructs are legal inside a string. */
   it('leaves comment-like and comma-trailing text inside strings alone', () => {
      const source = '{"url": "https://example.com/*x*/", "note": "ends in a comma,"}';
      expect(JSON.parse(stripJsonComments(source))).toEqual({ url: 'https://example.com/*x*/', note: 'ends in a comma,' });
   });

   it('leaves plain JSON byte-identical', () => {
      const source = '{"a":[1,2],"b":{"c":true}}';
      expect(stripJsonComments(source)).toBe(source);
   });
});

describe('findWorkspaceRoot', () => {
   it('walks up to the nearest ancestor declaring workspaces', () => {
      expect(findWorkspaceRoot(path.join(ROOT, 'packages/new-lang'), fakeProbe(MONOREPO))).toBe(ROOT);
   });

   it('returns undefined outside any workspace', () => {
      const probe = fakeProbe({ 'package.json': { name: 'plain-package' } });
      expect(findWorkspaceRoot(path.join(ROOT, 'somewhere'), probe)).toBeUndefined();
   });
});

describe('findBaseTsconfig', () => {
   /**
    * The rule with teeth. A monorepo root's `tsconfig.json` is routinely a
    * SOLUTION file, so picking it by name would emit an `extends` that inherits
    * nothing — and nothing about the emitted project would look wrong until a
    * compiler setting silently stopped applying.
    */
   it('skips a solution-style tsconfig.json for the one that carries compilerOptions', () => {
      expect(findBaseTsconfig(ROOT, fakeProbe(MONOREPO))?.file).toBe('tsconfig.base.json');
   });

   it('takes tsconfig.json when it is the one carrying compilerOptions', () => {
      const probe = fakeProbe({ 'package.json': { workspaces: [] }, 'tsconfig.json': { compilerOptions: { strict: true } } });
      expect(findBaseTsconfig(ROOT, probe)?.file).toBe('tsconfig.json');
   });

   it('finds nothing when every candidate is a solution file', () => {
      const probe = fakeProbe({ 'package.json': { workspaces: [] }, 'tsconfig.json': { files: [], references: [] } });
      expect(findBaseTsconfig(ROOT, probe)).toBeUndefined();
   });
});

describe('workspaceGlobCovers', () => {
   it("covers a direct child of a '*' glob but not a grandchild", () => {
      expect(workspaceGlobCovers('packages/*', 'packages/new-lang')).toBe(true);
      // `*` does not cross a separator, so a nested scaffold needs its own entry.
      expect(workspaceGlobCovers('packages/*', 'packages/cli/out/scaffold')).toBe(false);
   });

   it('matches a literal entry exactly, a whole-segment glob, and a partial-segment one', () => {
      expect(workspaceGlobCovers('examples/order-flow/server', 'examples/order-flow/server')).toBe(true);
      expect(workspaceGlobCovers('examples/order-flow/server', 'examples/order-flow/client')).toBe(false);
      expect(workspaceGlobCovers('examples/order-flow/*', 'examples/order-flow/client')).toBe(true);
      // `*` stands for any run WITHIN a segment, so it need not be the whole one.
      expect(workspaceGlobCovers('examples/order-flow/*-app', 'examples/order-flow/theia-app')).toBe(true);
   });

   it("lets '**' cross separators", () => {
      expect(workspaceGlobCovers('packages/**', 'packages/cli/out/scaffold')).toBe(true);
   });
});

describe('inferPackageScope', () => {
   it('reads a unanimous scope off the siblings, not off the root manifest', () => {
      // The root is `hydranium-root` — naming the repo, not the scope. Reading it
      // would confidently produce the wrong package name.
      expect(inferPackageScope(ROOT, ['packages/*', 'examples/order-flow/server'], fakeProbe(MONOREPO))).toBe('@acme');
   });

   it('abstains when the siblings disagree', () => {
      const probe = fakeProbe({
         'package.json': { workspaces: ['packages/*'] },
         'packages/one/package.json': { name: '@acme/one' },
         'packages/two/package.json': { name: '@other/two' }
      });
      expect(inferPackageScope(ROOT, ['packages/*'], probe)).toBeUndefined();
   });

   it('abstains when no sibling is scoped', () => {
      const probe = fakeProbe({ 'package.json': { workspaces: ['packages/*'] }, 'packages/one/package.json': { name: 'one' } });
      expect(inferPackageScope(ROOT, ['packages/*'], probe)).toBeUndefined();
   });
});

describe('detectWorkspace', () => {
   it('reports the placement of a package a glob already covers', () => {
      const detection = detectWorkspace(path.join(ROOT, 'packages/new-lang'), fakeProbe(MONOREPO));
      expect(detection).toMatchObject({
         rootDir: ROOT,
         targetPath: 'packages/new-lang',
         coveredBy: 'packages/*',
         scope: '@acme',
         baseTsconfig: '../../tsconfig.base.json'
      });
   });

   /**
    * The case that decides whether a root-manifest line gets printed: `examples/`
    * is listed one entry at a time, so a new example is NOT covered even though
    * its siblings are.
    */
   it('leaves coveredBy undefined when no glob reaches the target', () => {
      const detection = detectWorkspace(path.join(ROOT, 'examples/new-example'), fakeProbe(MONOREPO));
      expect(detection?.coveredBy).toBeUndefined();
      expect(detection?.targetPath).toBe('examples/new-example');
   });

   it('returns undefined outside a workspace', () => {
      expect(detectWorkspace(path.join(ROOT, 'anywhere'), fakeProbe({ 'package.json': { name: 'plain' } }))).toBeUndefined();
   });

   /**
    * `init .` at the top of a monorepo, or a target that resolved to the cwd.
    * There is no member to place, and reporting one names a directory the user
    * never asked for — which reads as the scaffolder ignoring the target.
    */
   it('returns undefined when the target IS the workspace root', () => {
      expect(detectWorkspace(ROOT, fakeProbe(MONOREPO))).toBeUndefined();
   });

   /** A relative target resolves against the cwd, not against anything the scaffolder picks. */
   it('resolves a relative target against the working directory', () => {
      const probe = fakeProbe(MONOREPO);
      const outside = detectWorkspace(path.resolve(ROOT, '../elsewhere/lang'), probe);
      expect(outside).toBeUndefined();
      expect(detectWorkspace(path.join(ROOT, 'packages/lang'), probe)?.targetPath).toBe('packages/lang');
   });
});

describe('findPrettierPrintWidth', () => {
   it('reads the width from package.json, the JSON configs, and a JS module alike', () => {
      // The JS module form is the one that matters: it is what most repos
      // actually have, and no JSON parser can reach it — so a detector built on
      // `readJson` alone would miss the common case and change nothing.
      expect(findPrettierPrintWidth(ROOT, fakeProbe({ 'package.json': { prettier: { printWidth: 100 } } }))).toBe(100);
      expect(findPrettierPrintWidth(ROOT, fakeProbe({ '.prettierrc.json': { printWidth: 90 } }))).toBe(90);
      expect(findPrettierPrintWidth(ROOT, fakeProbe({ '.prettierrc.js': 'module.exports = { printWidth: 140 };' }))).toBe(140);
      expect(findPrettierPrintWidth(ROOT, fakeProbe({ 'prettier.config.mjs': 'export default {\n   printWidth: 77\n};' }))).toBe(77);
   });

   it('answers undefined rather than guessing when the repo pins no width', () => {
      // Undefined is what makes the scaffold fall back to its own budget. A
      // zero or a NaN here would wrap every emitted line.
      expect(findPrettierPrintWidth(ROOT, fakeProbe({ 'package.json': { name: 'repo' } }))).toBeUndefined();
      expect(findPrettierPrintWidth(ROOT, fakeProbe({ '.prettierrc.js': 'module.exports = { singleQuote: true };' }))).toBeUndefined();
   });
});

describe('findEslintConfig', () => {
   it('finds either config generation, and nothing when the repo does not lint', () => {
      expect(findEslintConfig(ROOT, fakeProbe({ 'eslint.config.js': {} }))).toBe('eslint.config.js');
      expect(findEslintConfig(ROOT, fakeProbe({ 'eslint.config.mts': {} }))).toBe('eslint.config.mts');
      expect(findEslintConfig(ROOT, fakeProbe({ '.eslintrc.json': {} }))).toBe('.eslintrc.json');
      expect(findEslintConfig(ROOT, fakeProbe({ 'package.json': { name: 'repo' } }))).toBeUndefined();
   });
});
