/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Unit tier for the `init` scaffolding command. The pure name-derivation + file
 * planning are asserted directly; the write path is exercised via
 * `__writeFilesForTest` so nothing touches disk. The generated project's actual
 * compile + CLI round-trip is covered by dogfooding during development (scaffold →
 * langium generate → tsc → reflect/lint/validate).
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type InitFile, type InitHead, planInitFiles, resolveInitComposition, runInit } from '../src/commands/init.js';
import type { JsonValue, WorkspaceProbe } from '../src/commands/init-workspace.js';

describe('resolveInitComposition', () => {
   it('derives a single grammar named after the project when none is given', () => {
      expect(resolveInitComposition('Bookstore')).toEqual({
         // Matched loosely because it is read from this package's own manifest
         // and moves with every release; the golden tier asserts what it must be.
         frameworkVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
         name: 'Bookstore',
         projectId: 'bookstore',
         heads: ['lsp', 'data'],
         grammars: [
            {
               grammar: 'Bookstore',
               grammarId: 'bookstore',
               languageId: 'bookstore',
               extensions: ['bookstore'],
               entryRule: 'BookstoreModel',
               nodeRule: 'BookstoreNode',
               diagram: false
            }
         ],
         packaging: { private: true }
      });
      expect(resolveInitComposition('MyLang').grammars[0]).toMatchObject({
         grammarId: 'my-lang',
         languageId: 'my-lang',
         extensions: ['my-lang']
      });
   });

   it('honours explicit language-id and extension overrides (stripping a leading dot)', () => {
      const composition = resolveInitComposition('Bookstore', [{ name: 'Bookstore', languageId: 'shop', extensions: ['.shp'] }]);
      expect(composition.grammars[0]).toMatchObject({ languageId: 'shop', extensions: ['shp'] });
      // The project id stays derived from the name — it names the package, the
      // DI module file and the data-server port command, none of which a
      // language id may rename.
      expect(composition.projectId).toBe('bookstore');
   });

   it('keeps projectId derived from the name even when the language id is overridden', () => {
      expect(resolveInitComposition('OrderFlow', [{ name: 'Domain', languageId: 'order-flow-domain' }]).projectId).toBe('order-flow');
   });

   it('qualifies the language id with the grammar, and takes the extension from it', () => {
      expect(resolveInitComposition('OrderFlow', [{ name: 'Domain' }]).grammars[0]).toMatchObject({
         grammar: 'Domain',
         grammarId: 'domain',
         languageId: 'order-flow-domain',
         extensions: ['domain']
      });
   });

   it('does not qualify the language id when a lone grammar matches the project name', () => {
      // `--grammar Foo --name Foo` is a redundant but legal invocation, and
      // `foo-foo` would be a poor id.
      expect(resolveInitComposition('Foo', [{ name: 'Foo' }]).grammars[0]).toMatchObject({ languageId: 'foo', extensions: ['foo'] });
   });

   it('qualifies every language id once there is more than one grammar', () => {
      // Including the one whose name matches the project: with a set, the
      // consistent reading beats one member being special.
      const composition = resolveInitComposition('Foo', [{ name: 'Foo' }, { name: 'Bar' }]);
      expect(composition.grammars.map(grammar => grammar.languageId)).toEqual(['foo-foo', 'foo-bar']);
   });

   it('keeps a multi-word grammar kebab-cased in the id and the extension', () => {
      expect(resolveInitComposition('OrderFlow', [{ name: 'ProcessFlow' }]).grammars[0]).toMatchObject({
         grammarId: 'process-flow',
         languageId: 'order-flow-process-flow',
         extensions: ['process-flow']
      });
   });

   it('derives per-grammar entry and node rules', () => {
      // One langium-cli run over N grammars emits ONE combined ast.ts, so a
      // fixed `Model` would appear in it once per grammar.
      const composition = resolveInitComposition('OrderFlow', [{ name: 'Domain' }, { name: 'Process' }]);
      expect(composition.grammars.map(grammar => grammar.entryRule)).toEqual(['DomainModel', 'ProcessModel']);
      // `Node`, not `Element`: `<projectName>Element` is the transfer model's
      // base interface, which a rule of that name would collide with.
      expect(composition.grammars.map(grammar => grammar.nodeRule)).toEqual(['DomainNode', 'ProcessNode']);
   });

   it('derives a distinct language id and extension for each of three grammars', () => {
      const composition = resolveInitComposition('OrderFlow', [
         { name: 'Domain' },
         { name: 'Process' },
         { name: 'Layout', extensions: ['layout'] }
      ]);
      expect(composition.grammars.map(grammar => grammar.languageId)).toEqual([
         'order-flow-domain',
         'order-flow-process',
         'order-flow-layout'
      ]);
      expect(composition.grammars.flatMap(grammar => grammar.extensions)).toEqual(['domain', 'process', 'layout']);
   });

   it('accepts several extensions for one grammar', () => {
      expect(resolveInitComposition('Bookstore', [{ name: 'Bookstore', extensions: ['.bk', 'bookstore'] }]).grammars[0].extensions).toEqual(
         ['bk', 'bookstore']
      );
   });

   it('rejects a name that is not a PascalCase identifier', () => {
      expect(() => resolveInitComposition('my-lang')).toThrow(/PascalCase identifier/);
      expect(() => resolveInitComposition('1Lang')).toThrow(/PascalCase identifier/);
      expect(() => resolveInitComposition('')).toThrow(/PascalCase identifier/);
   });

   it('rejects a grammar name that is not a PascalCase identifier', () => {
      // It prefixes generated TypeScript symbols, so the same rule applies.
      expect(() => resolveInitComposition('Bookstore', [{ name: 'my-grammar' }])).toThrow(/--grammar/);
   });

   it('rejects two grammars that resolve to the same file', () => {
      expect(() => resolveInitComposition('OrderFlow', [{ name: 'Domain' }, { name: 'Domain' }])).toThrow(/Duplicate grammar/);
   });

   it('rejects one extension claimed by two grammars', () => {
      // The check that earns its keep: Langium routes documents to a language
      // BY extension, so this is a silent mis-route rather than a name clash.
      expect(() =>
         resolveInitComposition('OrderFlow', [
            { name: 'Domain', extensions: ['flow'] },
            { name: 'Process', extensions: ['flow'] }
         ])
      ).toThrow(/claimed by both 'Domain' and 'Process'/);
   });

   it('rejects two grammars sharing a language id', () => {
      expect(() =>
         resolveInitComposition('OrderFlow', [
            { name: 'Domain', languageId: 'shared' },
            { name: 'Process', languageId: 'shared' }
         ])
      ).toThrow(/Duplicate language id/);
   });

   it('rejects an empty extension', () => {
      expect(() => resolveInitComposition('Bookstore', [{ name: 'Bookstore', extensions: ['.'] }])).toThrow(/cannot be empty/);
   });
});

describe('resolveInitComposition, heads', () => {
   it('defaults to the LSP and data heads', () => {
      expect(resolveInitComposition('Bookstore').heads).toEqual(['lsp', 'data']);
   });

   it('normalises the head set to composition order and drops duplicates', () => {
      // So `--heads glsp,lsp` and `--heads lsp,glsp` emit the same project.
      expect(resolveInitComposition('Bookstore', [], ['glsp', 'lsp', 'lsp']).heads).toEqual(['lsp', 'glsp']);
   });

   it('rejects a head set without lsp', () => {
      // It owns the workspace and the build pipeline, so the others have
      // nothing to serve without it.
      expect(() => resolveInitComposition('Bookstore', [], ['data'])).toThrow(/must include 'lsp'/);
   });

   it('rejects an unknown head', () => {
      expect(() => resolveInitComposition('Bookstore', [], ['lsp', 'rest' as InitHead])).toThrow(/Unknown head/);
   });

   it('derives the diagram grammar when glsp is on and there is only one', () => {
      const composition = resolveInitComposition('Bookstore', [], ['lsp', 'glsp']);
      expect(composition.grammars[0].diagram).toBe(true);
   });

   it('requires a marked grammar when glsp is on and there are several', () => {
      // A diagram type binds exactly one grammar, and guessing wrong surfaces
      // much later as references resolving against the wrong scope.
      expect(() => resolveInitComposition('OrderFlow', [{ name: 'Domain' }, { name: 'Process' }], ['lsp', 'glsp'])).toThrow(
         /no grammar carries --diagram. Mark the one the diagram edits: Domain, Process/
      );
   });

   it('marks only the named grammar when several are given', () => {
      const composition = resolveInitComposition(
         'OrderFlow',
         [{ name: 'Domain' }, { name: 'Process', diagram: true }, { name: 'Layout', extensions: ['layout'] }],
         ['lsp', 'data', 'glsp']
      );
      expect(composition.grammars.map(grammar => grammar.diagram)).toEqual([false, true, false]);
   });

   it('rejects --diagram when the head set has no glsp', () => {
      // --heads stays the single source of truth for the emitted dependencies.
      expect(() => resolveInitComposition('Bookstore', [{ name: 'Bookstore', diagram: true }], ['lsp', 'data'])).toThrow(
         /Add 'glsp' to --heads/
      );
   });

   it('leaves grammars undiagrammed when glsp is off', () => {
      expect(resolveInitComposition('Bookstore').grammars[0].diagram).toBe(false);
   });
});

describe('planInitFiles, heads', () => {
   const filesFor = (heads: readonly InitHead[]): InitFile[] => planInitFiles(resolveInitComposition('Bookstore', [], heads));
   const contentOf = (files: readonly InitFile[], path: string): string | undefined => files.find(file => file.path === path)?.content;

   it('emits only the LSP head for --heads lsp', () => {
      const files = filesFor(['lsp']);
      const main = contentOf(files, 'src/main.ts');
      expect(main).toContain('startLanguageServer(shared)');
      expect(main).not.toContain('DataServer');
      expect(main).not.toContain('startGlspServer');
      // No transfer-root import either, since nothing consumes it.
      expect(main).not.toContain('generated-transfer/transfer-model.js');
      expect(files.map(file => file.path).filter(path => path.startsWith('src/glsp/'))).toEqual([]);
      // The stdio data entry follows the head, not the project: with no data
      // head there is nothing for `hydranium-cli query` to talk to and the file
      // would not compile, since it names a transfer root the scaffold omits.
      expect(contentOf(files, 'src/data-server-main.ts')).toBeUndefined();
      expect(contentOf(files, 'package.json')).not.toContain('data-server-main');
   });

   it('emits the stdio data entry, and a bin key for it, with the data head', () => {
      // The only command line that reaches a scaffolded project's data head:
      // `main.ts` gives stdio to LSP and publishes the data head's socket port
      // over the LSP connection, which no `--server` client can ask for.
      const entry = contentOf(filesFor(['lsp', 'data']), 'src/data-server-main.ts');
      expect(entry).toContain("import { NodeFileSystem, startStdioServer } from '@hydranium/core/node';");
      expect(entry).toContain('new DataServer<BookstoreModel>(connection, shared)');
      expect(entry).toContain('workspace: process.argv[2] ?? process.cwd()');
      expect(contentOf(filesFor(['lsp', 'data']), 'package.json')).toContain('"bookstore-data-server": "lib/data-server-main.js"');
   });

   /**
    * Every `bin` target's SOURCE starts with a shebang, on line one.
    *
    * The FIRST line and not its presence anywhere: npm's install-time `fixBin`
    * sets the exec bit on a linked target without writing an interpreter line,
    * so a shebang on line two leaves `/bin/sh` reading whatever is above it —
    * which for a repo that runs a license sweep over the scaffold is the header
    * comment, and the observed failure is `Permission denied` on line 1.
    *
    * The path list is derived FROM the emitted `bin` map rather than written
    * out, so a new entry cannot be added without being covered; the equality
    * check is what stops it passing on an empty map.
    */
   it('starts every bin target on a shebang line', () => {
      const files = filesFor(['lsp', 'data', 'glsp']);
      const manifest = JSON.parse(contentOf(files, 'package.json') ?? '{}') as { bin?: Record<string, string> };
      const sources = Object.values(manifest.bin ?? {})
         .map(target => target.replace(/^lib\//, 'src/').replace(/\.js$/, '.ts'))
         .sort();

      expect(sources).toEqual(['src/data-server-main.ts', 'src/main.ts']);
      for (const source of sources) {
         expect(contentOf(files, source)?.split('\n')[0], source).toBe('#!/usr/bin/env node');
      }
   });

   it('derives the dependency block from the head set', () => {
      // The whole point of the head axis: the dependency list follows the head
      // set rather than being hand-maintained, which is how the two drift apart.
      // The framework pins are named without their VERSION here: it is derived
      // from the CLI's own manifest, so a literal would fail on the first
      // release. The golden tier asserts that derivation.
      const lspOnly = contentOf(filesFor(['lsp']), 'package.json');
      expect(lspOnly).toContain('"@hydranium/core":');
      expect(lspOnly).not.toContain('@hydranium/data-server');
      expect(lspOnly).not.toContain('@eclipse-glsp/server');

      const allHeads = contentOf(filesFor(['lsp', 'data', 'glsp']), 'package.json');
      expect(allHeads).toContain('"@hydranium/data-server":');
      expect(allHeads).toContain('"@eclipse-glsp/graph": "2.7.0"');
      expect(allHeads).toContain('"@eclipse-glsp/server": "2.7.0"');
      expect(allHeads).toContain('"@hydranium/glsp-server":');
      expect(allHeads).toContain('"reflect-metadata": "~0.2.2"');
      // ^6.1.3 and not ^6.0.0 — @eclipse-glsp/server@2.7.0 requires it.
      expect(allHeads).toContain('"inversify": "^6.1.3"');
   });

   it('emits the diagram file set and wires it into main for the glsp head', () => {
      const files = filesFor(['lsp', 'data', 'glsp']);
      expect(files.map(file => file.path).filter(path => path.startsWith('src/glsp/'))).toEqual([
         'src/glsp/bookstore/types.ts',
         'src/glsp/bookstore/state.ts',
         'src/glsp/bookstore/storage.ts',
         'src/glsp/bookstore/submission-handler.ts',
         'src/glsp/bookstore/gmodel-factory.ts',
         'src/glsp/bookstore/diagram-configuration.ts',
         'src/glsp/bookstore/create-node-operation-handler.ts',
         'src/glsp/bookstore/diagram-module.ts'
      ]);
      const main = contentOf(files, 'src/main.ts') ?? '';
      // `reflect-metadata` first: inversify reads decorator metadata at module
      // scope, so a later import is too late. Compare import STATEMENTS rather
      // than searching for the word, which also appears in the header prose.
      const imports = main.split('\n').filter(line => line.startsWith('import '));
      expect(imports[0]).toBe("import 'reflect-metadata';");
      expect(main).toContain('.configureDiagramModule(new BookstoreDiagramModule())');
      expect(main).toContain('BOOKSTORE_GLSP_PORT_COMMAND');
      expect(contentOf(files, 'src/head-ports.ts')).toContain("export const BOOKSTORE_GLSP_PORT_COMMAND = 'bookstore/glsp/port';");
   });

   it('binds the declared language and the full-text state in the diagram module', () => {
      const files = filesFor(['lsp', 'glsp']);
      const module = contentOf(files, 'src/glsp/bookstore/diagram-module.ts');
      // declareLanguage is the multi-grammar seam, and it names ONE grammar's
      // generated metadata constant.
      expect(module).toContain('return BookstoreLanguageMetaData;');
      expect(module).toContain('readonly diagramType = BOOKSTORE_DIAGRAM_TYPE;');
      expect(contentOf(files, 'src/glsp/bookstore/state.ts')).toContain(
         'export class BookstoreGlspState extends FullTextHydraniumGlspState<BookstoreModel> {}'
      );
      // The diagram type equals the language id, so the two cannot drift.
      expect(contentOf(files, 'src/glsp/bookstore/types.ts')).toContain("export const BOOKSTORE_DIAGRAM_TYPE = 'bookstore';");
   });

   it('emits a diagram only for the marked grammar', () => {
      const files = planInitFiles(
         resolveInitComposition('OrderFlow', [{ name: 'Domain' }, { name: 'Process', diagram: true }], ['lsp', 'data', 'glsp'])
      );
      const glspPaths = files.map(file => file.path).filter(path => path.startsWith('src/glsp/'));
      expect(glspPaths.every(path => path.startsWith('src/glsp/process/'))).toBe(true);
      expect(glspPaths).toHaveLength(8);
      // A grammar with no diagram still registers on the same server, which is
      // why the language binding is per-session rather than process-wide.
      expect(contentOf(files, 'src/main.ts')).toContain('.configureDiagramModule(new ProcessDiagramModule())');
   });

   it('leaves no unsubstituted token in any emitted head combination', () => {
      for (const heads of [['lsp'], ['lsp', 'data'], ['lsp', 'glsp'], ['lsp', 'data', 'glsp']] as InitHead[][]) {
         for (const file of filesFor(heads)) {
            expect(file.content, `${heads.join(',')} ${file.path} still has a token`).not.toMatch(/__[A-Z_]+__/);
         }
      }
   });
});

describe('planInitFiles', () => {
   const files = planInitFiles(resolveInitComposition('Bookstore'));
   const byPath = (path: string): InitFile | undefined => files.find(file => file.path === path);

   it('emits the full project file set with tokens substituted into paths', () => {
      expect(files.map(file => file.path).sort()).toEqual(
         [
            '.gitignore',
            'README.md',
            'langium-config.json',
            'package.json',
            'src/data-server-main.ts',
            'src/grammar/bookstore.langium',
            'src/head-ports.ts',
            'src/index.ts',
            'src/language-server/ast.ts',
            'src/language-server/bookstore-module.ts',
            'src/language-server/bookstore-serializer.ts',
            'src/main.ts',
            'src/services.ts',
            'test/linking.test.ts',
            'test/parsing.test.ts',
            'test/serialization.test.ts',
            'test/services.test.ts',
            'test/validating.test.ts',
            'tsconfig.json',
            'tsconfig.test.json',
            'vitest.config.ts'
         ].sort()
      );
   });

   it('leaves no unsubstituted __TOKEN__ in any generated file', () => {
      for (const file of files) {
         expect(file.content, `${file.path} still has a token`).not.toMatch(/__[A-Z_]+__/);
      }
   });

   it('substitutes the name into the module, config, and grammar content', () => {
      expect(byPath('src/language-server/bookstore-module.ts')?.content).toContain('export function createBookstoreServices(');
      expect(byPath('src/language-server/bookstore-module.ts')?.content).toContain('BookstoreGeneratedModule');
      expect(byPath('langium-config.json')?.content).toContain('"projectName": "Bookstore"');
      expect(byPath('langium-config.json')?.content).toContain('".bookstore"');
      expect(byPath('src/grammar/bookstore.langium')?.content).toContain('grammar Bookstore');
   });

   it('gives the lone grammar its own prefixed rules and inline terminals', () => {
      const grammar = byPath('src/grammar/bookstore.langium')?.content;
      expect(grammar).toContain('entry BookstoreModel:');
      expect(grammar).toContain('(nodes+=BookstoreNode)*;');
      expect(grammar).toContain('BookstoreNode:');
      // No fragment to import when there is nothing to share it with.
      expect(grammar).toContain('terminal ID:');
      expect(grammar).not.toContain("import './common'");
      expect(byPath('src/grammar/common.langium')).toBeUndefined();
   });

   it('points services.js at the substituted module filename', () => {
      expect(byPath('src/services.ts')?.content).toContain("from './language-server/bookstore-module.js'");
   });

   it('makes the package entry the barrel, not the server launcher', () => {
      // `main.ts` opens an LSP connection at module scope, so pointing `main`
      // at it would start a server as an import side effect.
      expect(byPath('package.json')?.content).toContain('"main": "lib/index.js"');
      expect(byPath('package.json')?.content).toContain('"bookstore": "lib/main.js"');
      expect(byPath('src/index.ts')?.content).not.toContain('./main.js');
   });

   /**
    * The key order `prettier-plugin-packagejson` canonicalises to, rendered WITH
    * `private` — the substitution that actually moves a key position.
    *
    * Any other order is rewritten by the scaffolded project's own first `format`
    * run, a diff on a file the adopter never touched, and it makes a byte-compare
    * against a formatted copy of this emission unsatisfiable. The independent
    * oracle is the repo formatter over the re-derived provenance target; this
    * pins the property so a template edit cannot undo it unnoticed.
    */
   it('emits its manifest keys in the order the formatter canonicalises to', () => {
      const manifest =
         planInitFiles(resolveInitComposition('Bookstore', undefined, undefined, { private: true })).find(
            file => file.path === 'package.json'
         )?.content ?? '';

      expect(Object.keys(JSON.parse(manifest) as Record<string, unknown>)).toEqual([
         'name',
         'version',
         'private',
         'description',
         'keywords',
         'license',
         'author',
         'type',
         'main',
         'types',
         'bin',
         'files',
         'scripts',
         'dependencies',
         'devDependencies',
         'engines'
      ]);
   });

   it('declares files, so a first publish cannot omit the bin target', () => {
      // With no `files` and no `.npmignore` npm falls back to `.gitignore`, which
      // this scaffold emits with `lib/` in it: npm force-includes `main` and
      // omits everything else beneath it, so the `bin` target is absent from the
      // tarball while the publish reports success.
      const manifest = JSON.parse(byPath('package.json')?.content ?? '{}') as { files?: string[]; bin?: Record<string, string> };
      const targets = Object.values(manifest.bin ?? {});
      const covered = targets.filter(target => (manifest.files ?? []).includes(target.split('/')[0]));

      expect(byPath('.gitignore')?.content).toContain('lib/');
      // Named as a set rather than counted, so it cannot pass on an empty `bin`.
      expect(covered).toEqual(targets);
      expect(targets.length).toBeGreaterThan(0);
   });

   it('scaffolds a runnable test setup, not just source', () => {
      expect(byPath('package.json')?.content).toContain('"test": "npm run typecheck:test && vitest run"');
      expect(byPath('test/services.test.ts')?.content).toContain("from '../src/services.js'");
      expect(byPath('vitest.config.ts')?.content).toContain("include: ['test/**/*.{test,spec}.ts']");
   });

   it('types the single-grammar data head with that grammar’s transfer root', () => {
      expect(byPath('src/main.ts')?.content).toContain('new DataServer<BookstoreModel>(dataConnection, shared)');
   });

   it('separates the shared and per-language generated symbols by name role', () => {
      const split = planInitFiles(resolveInitComposition('OrderFlow', [{ name: 'Domain' }]));
      // The DI module is PROJECT-level — it composes every language and exports
      // `create<Name>Services` — so its filename follows the project id, not the
      // routing key, which now carries a grammar suffix.
      const module = split.find(file => file.path === 'src/language-server/order-flow-module.ts')?.content;

      // `projectName` drives the shared module, the grammar declaration the
      // per-language one. Conflating them only works while they are equal.
      expect(module).toContain("import { DomainGeneratedModule, OrderFlowGeneratedSharedModule } from './generated/module.js'");
      expect(module).toContain('generated: OrderFlowGeneratedSharedModule');
      expect(module).toContain('generated: DomainGeneratedModule');
      expect(module).toContain('return { shared, Domain: language };');
      // The grammar file follows the GRAMMAR, so a second grammar lands beside
      // it rather than needing the first one renamed.
      expect(split.find(file => file.path === 'src/grammar/domain.langium')?.content).toMatch(/^grammar Domain\n/);
   });

   it('keys the data-server port command by the project, not the language', () => {
      const split = planInitFiles(resolveInitComposition('OrderFlow', [{ name: 'Domain', languageId: 'order-flow-domain' }]));

      // One data server per process serves every registered grammar, so a
      // language-derived name would tie a project endpoint to the first grammar.
      const headPorts = split.find(file => file.path === 'src/head-ports.ts')?.content;
      expect(headPorts).toContain("ORDER_FLOW_DATA_SERVER_PORT_COMMAND = 'order-flow/data-server/port'");

      // The literal lives ONLY there: `main.ts` is an executable entry, so a
      // constant declared in it is unreachable to the host that must name it.
      expect(headPorts).toContain('export const');
      expect(split.find(file => file.path === 'src/main.ts')?.content).not.toContain("'order-flow/data-server/port'");
      expect(split.find(file => file.path === 'src/index.ts')?.content).toContain("export * from './head-ports.js'");
   });

   it('asks langium-cli for a TextMate grammar, and gitignores the output', () => {
      expect(byPath('langium-config.json')?.content).toContain('"out": "syntaxes/bookstore.tmLanguage.json"');
      expect(byPath('.gitignore')?.content).toContain('syntaxes/');
      expect(byPath('package.json')?.content).toContain('rimraf lib syntaxes');
   });

   it('opens every .ts file with a line-comment run rather than a block comment', () => {
      // A license-header tool typically REPLACES the leading block comment, so
      // file-purpose prose in that position is silently deleted the first time
      // an adopter runs theirs over the scaffold.
      const sources = files.filter(file => file.path.endsWith('.ts'));
      expect(sources.length).toBeGreaterThan(0);
      expect(sources.filter(file => file.content.startsWith('/*')).map(file => file.path)).toEqual([]);
   });
});

describe('planInitFiles, multi-grammar', () => {
   const composition = resolveInitComposition('OrderFlow', [
      { name: 'Domain' },
      { name: 'Process' },
      { name: 'Layout', extensions: ['layout'] }
   ]);
   const files = planInitFiles(composition);
   const byPath = (path: string): string | undefined => files.find(file => file.path === path)?.content;

   it('emits one grammar file per grammar plus the shared fragment', () => {
      expect(files.map(file => file.path).filter(path => path.startsWith('src/grammar/'))).toEqual([
         'src/grammar/common.langium',
         'src/grammar/domain.langium',
         'src/grammar/process.langium',
         'src/grammar/layout.langium'
      ]);
   });

   it('moves the terminals into the fragment and imports it from each grammar', () => {
      expect(byPath('src/grammar/common.langium')).toContain('terminal ID:');
      for (const grammarId of ['domain', 'process', 'layout']) {
         const grammar = byPath(`src/grammar/${grammarId}.langium`);
         expect(grammar, grammarId).toContain("import './common'");
         // Declaring them again in each grammar is what the fragment exists to
         // avoid — the token sets would drift apart.
         expect(grammar, grammarId).not.toContain('terminal ID:');
      }
   });

   it('gives each grammar its own entry rule so the combined ast.ts has no collision', () => {
      expect(byPath('src/grammar/domain.langium')).toContain('entry DomainModel:');
      expect(byPath('src/grammar/process.langium')).toContain('entry ProcessModel:');
      expect(byPath('src/grammar/layout.langium')).toContain('entry LayoutModel:');
   });

   it('registers every language in one langium-config, with its own extension', () => {
      const config = byPath('langium-config.json');
      expect(config).toContain('"id": "order-flow-domain"');
      expect(config).toContain('"id": "order-flow-process"');
      expect(config).toContain('"id": "order-flow-layout"');
      expect(config).toContain('"fileExtensions": [".layout"]');
      // One config, one projectName: `AstReflection` is a single shared slot.
      expect(config?.match(/"projectName"/g)).toHaveLength(1);
   });

   it('composes the further grammars through additionalLanguages', () => {
      const module = byPath('src/language-server/order-flow-module.ts');
      expect(module).toContain('generated: DomainGeneratedModule');
      // Each further grammar carries its OWN adopter module. Without it
      // `additionalLanguages` falls back to the primary's, which would bind the
      // first grammar's serializer for every language.
      expect(module).toContain('{ generated: ProcessGeneratedModule, adopter: () => ProcessLanguageModule }');
      expect(module).toContain('{ generated: LayoutGeneratedModule, adopter: () => LayoutLanguageModule }');
      expect(module).toContain('return { shared, Domain: languages[0], Process: languages[1], Layout: languages[2] };');
   });

   it('binds lsp.configurationRoot explicitly rather than taking registration order', () => {
      // The framework warns when several languages are registered and the root
      // is left to default, because the default is the first registered id.
      const module = byPath('src/language-server/order-flow-module.ts');
      expect(module).toContain("export const ORDER_FLOW_CONFIGURATION_ROOT = 'order-flow';");
      expect(module).toContain('configurationRoot: () => ORDER_FLOW_CONFIGURATION_ROOT');
   });

   it('types the data head with the union of every transfer root', () => {
      // One data server per process serves every grammar.
      expect(byPath('src/main.ts')).toContain('new DataServer<DomainModel | LayoutModel | ProcessModel>(dataConnection, shared)');
      expect(byPath('src/main.ts')).toContain(
         "import type { DomainModel, LayoutModel, ProcessModel } from './language-server/generated-transfer/transfer-model.js';"
      );
   });

   it('leaves the diagnostics provider to the platform default', () => {
      // A scaffolded host is a Node host and gets the real implementation with
      // no wiring, because the default is selected by the data-server package's
      // `browser` field. Asserted as an ABSENCE so the scaffold cannot quietly
      // regrow a line every adopter would have to understand and none needs.
      expect(byPath('src/main.ts')).not.toContain('nodeDataServerDiagnostics');
      expect(byPath('src/main.ts')).not.toContain('diagnostics:');
   });

   it('asserts every registered language in the scaffolded test', () => {
      const test = byPath('test/services.test.ts');
      expect(test).toContain('registers all 3 languages');
      expect(test).toContain("toEqual(['order-flow-domain', 'order-flow-process', 'order-flow-layout'])");
      expect(test).toContain("toEqual(['.domain', '.process', '.layout'])");
   });

   it('leaves no unsubstituted token in any generated file', () => {
      for (const file of files) {
         expect(file.content, `${file.path} still has a token`).not.toMatch(/__[A-Z_]+__/);
      }
   });
});

describe('runInit', () => {
   it('plans the files under the resolved target dir and reports next steps', () => {
      const lines: string[] = [];
      let captured: { targetDir: string; files: readonly InitFile[] } | undefined;
      runInit({
         targetDir: 'out/bookstore',
         name: 'Bookstore',
         write: line => lines.push(line),
         __writeFilesForTest: (targetDir, files) => {
            captured = { targetDir, files };
         }
      });
      expect(captured?.files).toHaveLength(21);
      // `path.join`, not a literal: the target is produced by `path.resolve`,
      // which emits the platform separator, so a hardcoded `/` asserts nothing
      // on Windows beyond the separator itself.
      expect(captured?.targetDir.endsWith(path.join('out', 'bookstore'))).toBe(true);
      const output = lines.join('');
      expect(output).toContain('Scaffolded Bookstore (21 files, heads: lsp,data, 1 grammar(s): Bookstore)');
      expect(output).toContain('npm run build');
      expect(output).toContain('npm test');
      // `npx`, not a bare invocation: the scaffold installs `@hydranium/cli` as a
      // devDependency, so a bare command resolves only with a global install.
      expect(output).toContain('  npx hydranium-cli reflect --services ./lib/services.js\n');
      expect(output).toContain('no license header');
   });

   it('reports the grammar count and names for a multi-grammar scaffold', () => {
      const lines: string[] = [];
      let captured: { targetDir: string; files: readonly InitFile[] } | undefined;
      runInit({
         targetDir: 'out/order-flow',
         name: 'OrderFlow',
         grammars: [{ name: 'Domain' }, { name: 'Process' }, { name: 'Layout', extensions: ['layout'] }],
         write: line => lines.push(line),
         __writeFilesForTest: (targetDir, files) => {
            captured = { targetDir, files };
         }
      });
      // 21 single-grammar files + two further grammars, their two serializers and
      // the shared fragment.
      expect(captured?.files).toHaveLength(26);
      expect(lines.join('')).toContain('Scaffolded OrderFlow (26 files, heads: lsp,data, 3 grammar(s): Domain, Process, Layout)');
   });

   it('names the diagram grammar and the head set for a three-head scaffold', () => {
      const lines: string[] = [];
      let captured: { targetDir: string; files: readonly InitFile[] } | undefined;
      runInit({
         targetDir: 'out/order-flow',
         name: 'OrderFlow',
         heads: ['lsp', 'data', 'glsp'],
         grammars: [{ name: 'Domain' }, { name: 'Process', diagram: true }, { name: 'Layout', extensions: ['layout'] }],
         write: line => lines.push(line),
         __writeFilesForTest: (targetDir, files) => {
            captured = { targetDir, files };
         }
      });
      // 26 multi-grammar files + the eight for the one diagram.
      expect(captured?.files).toHaveLength(34);
      expect(lines.join('')).toContain(
         'Scaffolded OrderFlow (34 files, heads: lsp,data,glsp, 3 grammar(s): Domain, Process (diagram), Layout)'
      );
   });
});

/**
 * `--monorepo`, over an in-memory workspace.
 *
 * The detection RULES are covered in `init-workspace.test.ts`; what is asserted
 * here is what the scaffold does with them — which is the part an adopter sees.
 */
/**
 * What the templates DO with the two detected workspace facts. The detection
 * rules themselves are covered in `init-workspace.test.ts`; a placement is
 * supplied directly here so neither half can pass by leaning on the other.
 */
describe('planInitFiles, detected workspace facts', () => {
   const plan = (workspace: { printWidth?: number; eslintConfig?: string }): readonly InitFile[] =>
      planInitFiles(
         resolveInitComposition('Bookstore', undefined, ['lsp', 'data', 'glsp'], {
            private: true,
            workspace: { targetPath: 'packages/bookstore', ...workspace }
         })
      );
   const contentOf = (files: readonly InitFile[], path: string): string => files.find(file => file.path === path)?.content ?? '';

   it('wraps emitted imports at the detected printWidth', () => {
      // The same import at two budgets, asserted as a LINE COUNT rather than a
      // substring: a wrapped and an unwrapped import contain the same symbols,
      // so any `toContain` over them passes in both states.
      const importLines = (files: readonly InitFile[]): number =>
         contentOf(files, 'src/glsp/bookstore/diagram-module.ts')
            .split('\n')
            .filter(line => line.startsWith('import') || line.startsWith('   ') || line.startsWith('} from')).length;

      expect(importLines(plan({ printWidth: 400 }))).toBeLessThan(importLines(plan({ printWidth: 60 })));
   });

   it('falls back to the scaffold budget when the workspace pins no width', () => {
      // Byte-identical to an explicit 120, which is what "falls back" has to
      // mean; asserting merely that it renders would pass at any width.
      expect(contentOf(plan({}), 'src/main.ts')).toBe(contentOf(plan({ printWidth: 120 }), 'src/main.ts'));
   });

   it('emits a lint script only where the workspace has an eslint config', () => {
      expect(contentOf(plan({ eslintConfig: 'eslint.config.js' }), 'package.json')).toContain('"lint": "eslint src test --max-warnings 0"');
      expect(contentOf(plan({}), 'package.json')).not.toContain('"lint"');
   });
});

describe('runInit --monorepo', () => {
   const ROOT = path.resolve('/repo');
   const TARGET = path.join(ROOT, 'packages/bookstore');

   const TREE: Record<string, JsonValue> = {
      [path.join(ROOT, 'package.json')]: { name: 'repo-root', workspaces: ['packages/*'] },
      // A solution file, as a monorepo root's usually is: extending THIS would
      // inherit nothing, so detection must reach past it.
      [path.join(ROOT, 'tsconfig.json')]: { files: [], references: [] },
      [path.join(ROOT, 'tsconfig.base.json')]: {
         compilerOptions: { target: 'ES2022', strict: true, module: 'CommonJS', types: ['node'] }
      },
      [path.join(ROOT, 'packages/core/package.json')]: { name: '@acme/core' }
   };

   const probe: WorkspaceProbe = {
      readJson: filePath => TREE[filePath],
      listDirectories: directory =>
         [...new Set(Object.keys(TREE).map(filePath => path.relative(directory, filePath).split(path.sep)))]
            .filter(segments => segments.length > 1 && !segments[0].startsWith('..'))
            .map(segments => segments[0]),
      listFiles: directory =>
         Object.keys(TREE)
            .map(filePath => path.relative(directory, filePath))
            .filter(relative => !relative.includes(path.sep) && !relative.startsWith('..')),
      readText: filePath => {
         const content = TREE[filePath];
         return content === undefined ? undefined : typeof content === 'string' ? content : JSON.stringify(content);
      }
   };

   /** Scaffold into the fake workspace and return the emitted files plus the printed output. */
   function scaffold(options: { scope?: string; public?: boolean } = {}): { files: readonly InitFile[]; output: string } {
      const lines: string[] = [];
      let captured: readonly InitFile[] = [];
      runInit({
         targetDir: TARGET,
         name: 'Bookstore',
         monorepo: true,
         probe,
         ...options,
         write: line => lines.push(line),
         __writeFilesForTest: (_targetDir, files) => {
            captured = files;
         }
      });
      return { files: captured, output: lines.join('') };
   }

   /** The content of one emitted file, by path. */
   function contentOf(files: readonly InitFile[], filePath: string): string | undefined {
      return files.find(file => file.path === filePath)?.content;
   }

   /**
    * The load-bearing assertion, and the reason the fake base is DELIBERATELY
    * partial — it separates the three cases that must behave differently:
    *
    * - same value in the base (`target`, `strict`, `types`) → dropped;
    * - different value (`module`: the base says `CommonJS`, the emitted ESM
    *   needs `NodeNext`) → kept, because inheriting it would break every import;
    * - absent from the base (`lib`, `skipLibCheck`, …) → kept.
    *
    * A base config that happened to supply everything would show only the first.
    */
   it('extends the base config and keeps only the options it does not inherit', () => {
      const tsconfig = contentOf(scaffold().files, 'tsconfig.json');
      expect(tsconfig).toBe(
         `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
`
      );
      // The per-package paths lead, and never come from a base: one that
      // supplied them would be pointing every member at one directory.
      expect(tsconfig).not.toContain('"target"');
      expect(tsconfig).not.toContain('"strict"');
   });

   it('narrows .gitignore to the one entry the workspace root cannot be assumed to have', () => {
      const { files, output } = scaffold();
      // Same file count as a standalone single-grammar scaffold: the member
      // keeps the file and drops three of its four entries, rather than
      // dropping the file and losing `syntaxes/` with it.
      expect(files).toHaveLength(21);
      // The RULES, not the file text: the comment above them names the three
      // entries this file deliberately omits, so a substring search over the
      // whole file finds every one of them and proves nothing.
      const rules = (contentOf(files, '.gitignore') ?? '')
         .split('\n')
         .map(line => line.trim())
         .filter(line => line.length > 0 && !line.startsWith('#'));
      expect(rules).toEqual(['syntaxes/']);
      expect(output).toContain('.gitignore holds `syntaxes/` only');
   });

   it('scopes the package name and addresses itself by --prefix', () => {
      const packageJson = contentOf(scaffold({ scope: '@acme' }).files, 'package.json');
      expect(packageJson).toContain('"name": "@acme/bookstore"');
      // A workspace member's scripts get run from the repo root, where a bare
      // `npm run` would reach the ROOT manifest.
      expect(packageJson).toContain('Run: npm --prefix packages/bookstore run generate:transfer-model');
   });

   /**
    * The manifest's `private` and `license` are one decision: the emitted
    * `license` is UNLICENSED, so a publishable default would grant no rights on
    * a public registry. Asserted in both directions because either alone passes
    * with the substitution stuck at one value.
    */
   it('withholds publication by default and releases it only for --public', () => {
      const byDefault = contentOf(scaffold().files, 'package.json');
      expect(byDefault).toContain('"name": "bookstore"');
      expect(byDefault).toContain('"private": true');
      expect(byDefault).toContain('"license": "UNLICENSED"');

      const published = contentOf(scaffold({ public: true }).files, 'package.json');
      expect(published).not.toContain('"private"');
   });

   /**
    * Detection knows the sibling scope, but does not APPLY it: the emitted
    * package name stays a function of the argv alone, which is what lets the
    * wizard's echoed command reproduce the scaffold anywhere.
    */
   it('suggests the siblings’ scope rather than adopting it', () => {
      const { files, output } = scaffold();
      expect(contentOf(files, 'package.json')).toContain('"name": "bookstore"');
      expect(output).toContain('pass --scope @acme to match them');
   });

   it('says the target is already covered rather than printing a root-manifest line', () => {
      expect(scaffold().output).toContain('Already covered by the "packages/*" workspaces entry');
   });

   it('prints the workspaces entry to add when no glob reaches the target', () => {
      const lines: string[] = [];
      runInit({
         targetDir: path.join(ROOT, 'examples/bookstore'),
         name: 'Bookstore',
         monorepo: true,
         probe,
         write: line => lines.push(line),
         __writeFilesForTest: () => undefined
      });
      const output = lines.join('');
      expect(output).toContain('Add this to "workspaces"');
      expect(output).toContain('"examples/bookstore"');
   });

   it('refuses --monorepo outside a workspace instead of quietly scaffolding standalone', () => {
      expect(() =>
         runInit({
            targetDir: TARGET,
            name: 'Bookstore',
            monorepo: true,
            probe: { readJson: () => undefined, listDirectories: () => [], listFiles: () => [], readText: () => undefined },
            write: () => undefined,
            __writeFilesForTest: () => undefined
         })
      ).toThrow(/no ancestor .* declaring 'workspaces'/);
   });

   it('rejects a scope that is not an npm scope', () => {
      expect(() => scaffold({ scope: 'acme' })).toThrow(/Invalid --scope 'acme'/);
   });
});
