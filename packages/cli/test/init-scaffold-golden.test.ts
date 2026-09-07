/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Golden of the whole `init` scaffold, rendered for one fixed name.
 *
 * The sibling unit tier pins the file set and the load-bearing substitutions;
 * this pins the bytes. The point is reviewability: a template edit shows up as a
 * diff of the emitted project, which is the artefact anyone actually reasons
 * about, rather than as a diff of escaped template strings.
 *
 * One concatenated `.txt` rather than a directory of real files, deliberately:
 * a tree of `.ts` files under `test/fixtures/` would be picked up by the
 * SPDX-header gate, which the scaffold output is supposed NOT to satisfy.
 *
 * Update with `vitest -u` after an intentional template change — and only then.
 * The framework version is deliberately NOT one: see {@link FRAMEWORK_VERSION_TOKEN}.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type InitComposition, type InitGrammarSpec, type InitHead, planInitFiles, resolveInitComposition } from '../src/commands/init.js';

const SEPARATOR = '='.repeat(78);

/**
 * The version the goldens are rendered at, standing in for the CLI's own.
 *
 * The emitted `@hydranium/*` pins are derived from `packages/cli/package.json`,
 * so goldens recorded at the live value would change on the first `changeset
 * version` — reddening this suite DURING a release, where it reads as the
 * release process breaking rather than as a golden doing its job. Re-recording
 * them each release would make that green and destroy the check: a golden
 * regenerated from whatever the code currently emits can no longer detect a
 * change in what the code emits. Substituting a token leaves every other byte
 * under the check, and the emitted pins still show their SHAPE.
 *
 * Not the `0.0.0` placeholder, deliberately: the goldens pin the PUBLISHED
 * scaffold, which is the one an adopter will ever see. The pre-publish variant
 * is asserted separately, below.
 */
const FRAMEWORK_VERSION_TOKEN = '__FRAMEWORK_VERSION__';

/** The scaffold as one reviewable document, each file under its path banner. */
function renderScaffold(name: string, grammars?: readonly InitGrammarSpec[], heads?: readonly InitHead[]): string {
   const composition: InitComposition = { ...resolveInitComposition(name, grammars, heads), frameworkVersion: FRAMEWORK_VERSION_TOKEN };
   return planInitFiles(composition)
      .map(file => `${SEPARATOR}\n${file.path}\n${SEPARATOR}\n${file.content}`)
      .join('\n');
}

/** The emitted `package.json`, parsed, for the three-head shape that carries every framework package. */
function emittedManifest(composition: InitComposition): Record<string, Record<string, string>> {
   const content = planInitFiles(composition).find(file => file.path === 'package.json')?.content ?? '';
   return JSON.parse(content) as Record<string, Record<string, string>>;
}

describe('init scaffold golden', () => {
   it('renders the pinned single-grammar scaffold', async () => {
      await expect(renderScaffold('Bookstore')).toMatchFileSnapshot('fixtures/init-scaffold.txt');
   });

   /**
    * The multi-grammar shape, pinned separately because almost every
    * count-dependent emission only appears here: the shared `common.langium`
    * fragment, `additionalLanguages`, the explicit `lsp.configurationRoot`, the
    * union-typed data head, and one `langium-config` entry per grammar.
    */
   it('renders the pinned multi-grammar scaffold', async () => {
      const grammars = [{ name: 'Domain' }, { name: 'Process' }, { name: 'Layout', extensions: ['diagram'] }];
      await expect(renderScaffold('OrderFlow', grammars)).toMatchFileSnapshot('fixtures/init-scaffold-multi-grammar.txt');
   });

   /**
    * The three-head shape, pinned because the GLSP head is the largest thing
    * `init` emits — eight files of DI wiring, type ids, an AST→GModel walk and
    * the starter operation handler — and because it is the only golden where the
    * derived dependency block carries the `@eclipse-glsp/*` set.
    *
    * Single-grammar deliberately: with one grammar the diagram is derived rather
    * than marked, which is the shape a new adopter starting from `--heads
    * lsp,data,glsp` gets.
    */
   it('renders the pinned three-head scaffold', async () => {
      await expect(renderScaffold('Bookstore', undefined, ['lsp', 'data', 'glsp'])).toMatchFileSnapshot('fixtures/init-scaffold-glsp.txt');
   });

   /**
    * The lockstep the goldens above deliberately cannot assert.
    *
    * Normalising the version out of them is what stops a release reddening this
    * suite; this is what stops that normalisation hiding a pin that has come
    * adrift from the CLI it ships inside. Read out of the manifest rather than
    * written down — a literal here would reintroduce the second source of truth
    * the derivation exists to remove, and would then need updating at exactly the
    * moment nobody is looking at it.
    *
    * The scope is versioned as one line, so the CLI's version is the framework's:
    * there is no per-package mapping and no way for a derived pin to name a
    * version at which a sibling was not published.
    */
   it('pins every framework dependency at the version of the CLI that emitted it', () => {
      const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }).version;
      const manifest = emittedManifest(resolveInitComposition('Bookstore', undefined, ['lsp', 'data', 'glsp']));
      const pins = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).filter(([name]) =>
         name.startsWith('@hydranium/')
      );

      // Named rather than counted, so the assertion below cannot pass by finding
      // nothing once a head stops contributing a framework package.
      expect(pins.map(([name]) => name).sort()).toEqual([
         '@hydranium/cli',
         '@hydranium/core',
         '@hydranium/data-server',
         '@hydranium/glsp-server',
         '@hydranium/langium',
         '@hydranium/protocol'
      ]);
      expect(pins.map(([name, pin]) => `${name}@${pin}`)).toEqual(pins.map(([name]) => `${name}@^${version}`));
   });

   /**
    * The disclosure the scaffold prints about its own pins, in both states.
    *
    * The half the derivation does not fix by itself: a note saying that
    * publishing will make `npm install` work has to STOP being printed once it
    * has, or it goes from wrong-about-the-future to simply wrong.
    */
   it('keeps the pre-publish yalc note only while the pins are the placeholder', () => {
      const published = resolveInitComposition('Bookstore');
      const readmeOf = (composition: InitComposition): string =>
         planInitFiles(composition).find(file => file.path === 'README.md')?.content ?? '';

      expect(readmeOf({ ...published, frameworkVersion: '0.0.0' })).toContain('Pre-publish note');
      expect(readmeOf({ ...published, frameworkVersion: '1.2.3' })).not.toContain('Pre-publish note');
   });
});
