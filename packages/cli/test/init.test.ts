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
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { type InitFile, type InitHead, planInitFiles, resolveInitComposition, runInit } from '../src/commands/init.js';
import { createNodeWorkspaceProbe, type JsonValue, type WorkspaceProbe } from '../src/commands/init-workspace.js';

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

   it('rejects two extensions that differ only in case', () => {
      // Each names a starter file, and those are one file on a case-insensitive file system.
      expect(() =>
         resolveInitComposition('OrderFlow', [
            { name: 'Domain', extensions: ['Flow'] },
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

   it.each(['.', 'x/../../../escape', 'a\\b', "it's"])('rejects the extension %j', extension => {
      expect(() => resolveInitComposition('Bookstore', [{ name: 'Bookstore', extensions: [extension] }])).toThrow(/Invalid extension/);
   });

   it.each(['', 'My-Lang', 'my.lang', "it's"])('rejects the language id %j', languageId => {
      expect(() => resolveInitComposition('Bookstore', [{ name: 'Bookstore', languageId }])).toThrow(/Invalid --language-id/);
   });
});

describe('resolveInitComposition with heads', () => {
   it('defaults to the LSP and data heads', () => {
      expect(resolveInitComposition('Bookstore').heads).toEqual(['lsp', 'data']);
   });

   it('normalises the head set to composition order and drops duplicates', () => {
      // So `--heads glsp,lsp` and `--heads lsp,glsp` emit the same project.
      expect(resolveInitComposition('Bookstore', [], ['glsp', 'lsp', 'lsp']).heads).toEqual(['lsp', 'glsp']);
   });

   it('accepts a head set without lsp', () => {
      expect(resolveInitComposition('Bookstore', [], ['glsp', 'data']).heads).toEqual(['data', 'glsp']);
   });

   it('rejects an unknown head', () => {
      expect(() => resolveInitComposition('Bookstore', [], ['lsp', 'rest' as InitHead])).toThrow(/Unknown head/);
   });

   it('derives the diagram grammar when glsp is on and there is only one', () => {
      const composition = resolveInitComposition('Bookstore', [], ['lsp', 'glsp']);
      expect(composition.grammars[0].diagram).toBe(true);
   });

   it('requires a marked grammar when glsp is on and there are several', () => {
      // The scaffolded diagram is typed over one grammar's model, so a guess
      // would emit a diagram of the wrong model.
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

describe('planInitFiles with heads', () => {
   const filesFor = (heads: readonly InitHead[]): InitFile[] => planInitFiles(resolveInitComposition('Bookstore', [], heads));
   const contentOf = (files: readonly InitFile[], path: string): string | undefined => files.find(file => file.path === path)?.content;

   it('emits only the LSP head for --heads lsp', () => {
      const files = filesFor(['lsp']);
      const main = contentOf(files, 'server/src/main.ts');
      expect(main).toContain('startLanguageServer(shared)');
      expect(main).not.toContain('DataServer');
      expect(main).not.toContain('startGlspServer');
      // No import from protocol either: no transfer root, since nothing
      // consumes one, and no port command, since no socket head publishes one.
      expect(main).not.toContain("from 'bookstore-protocol'");
      expect(files.map(file => file.path).filter(path => path.startsWith('server/src/glsp/'))).toEqual([]);
      // The stdio data entry follows the head, not the project: with no data
      // head there is nothing for `hydranium-cli query` to talk to and the file
      // would not compile, since it names a transfer root the scaffold omits.
      expect(contentOf(files, 'server/src/data-server-main.ts')).toBeUndefined();
      expect(contentOf(files, 'server/package.json')).not.toContain('data-server-main');
   });

   it('emits the stdio data entry, and a bin key for it, with the data head', () => {
      // The only command line that reaches a scaffolded project's data head:
      // `main.ts` gives stdio to LSP and publishes the data head's socket port
      // over the LSP connection, which no `--server` client can ask for.
      const entry = contentOf(filesFor(['lsp', 'data']), 'server/src/data-server-main.ts');
      expect(entry).toContain("import { NodeFileSystem, startStdioServer } from '@hydranium/core/node';");
      expect(entry).toContain('new DataServer<BookstoreModel>(connection, shared)');
      expect(entry).toContain('workspace: process.argv[2] ?? process.cwd()');
      expect(contentOf(filesFor(['lsp', 'data']), 'server/package.json')).toContain('"bookstore-data-server": "lib/data-server-main.js"');
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
      const manifest = JSON.parse(contentOf(files, 'server/package.json') ?? '{}') as { bin?: Record<string, string> };
      const sources = Object.values(manifest.bin ?? {})
         .map(target => target.replace(/^lib\//, 'server/src/').replace(/\.js$/, '.ts'))
         .sort();

      expect(sources).toEqual(['server/src/data-server-main.ts', 'server/src/main.ts']);
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
      const lspOnly = contentOf(filesFor(['lsp']), 'server/package.json');
      expect(lspOnly).toContain('"@hydranium/core":');
      expect(lspOnly).not.toContain('@hydranium/data-server');
      expect(lspOnly).not.toContain('@eclipse-glsp/server');

      const allHeads = contentOf(filesFor(['lsp', 'data', 'glsp']), 'server/package.json');
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
      expect(files.map(file => file.path).filter(path => path.startsWith('server/src/glsp/'))).toEqual([
         'server/src/glsp/bookstore/state.ts',
         'server/src/glsp/bookstore/storage.ts',
         'server/src/glsp/bookstore/submission-handler.ts',
         'server/src/glsp/bookstore/gmodel-factory.ts',
         'server/src/glsp/bookstore/diagram-configuration.ts',
         'server/src/glsp/bookstore/create-node-operation-handler.ts',
         'server/src/glsp/bookstore/diagram-module.ts'
      ]);
      // The ids live in protocol, where a client reaches them without the server.
      expect(contentOf(files, 'protocol/src/bookstore-diagram-types.ts')).toContain('export type BookstoreElementType =');
      const main = contentOf(files, 'server/src/main.ts') ?? '';
      // `reflect-metadata` first: inversify reads decorator metadata at module
      // scope, so a later import is too late. Compare import STATEMENTS rather
      // than searching for the word, which also appears in the header prose.
      const imports = main.split('\n').filter(line => line.startsWith('import '));
      expect(imports[0]).toBe("import 'reflect-metadata';");
      expect(main).toContain('.configureDiagramModule(new BookstoreDiagramModule())');
      expect(main).toContain('BOOKSTORE_GLSP_SERVER_PORT_COMMAND');
      expect(contentOf(files, 'protocol/src/head-ports.ts')).toContain(
         "export const BOOKSTORE_GLSP_SERVER_PORT_COMMAND = 'bookstore/glsp-server/port';"
      );
   });

   it('binds the diagram type and the full-text state in the diagram module', () => {
      const files = filesFor(['lsp', 'glsp']);
      const module = contentOf(files, 'server/src/glsp/bookstore/diagram-module.ts');
      expect(module).toContain('readonly diagramType = BOOKSTORE_DIAGRAM_TYPE;');
      expect(contentOf(files, 'server/src/glsp/bookstore/state.ts')).toContain(
         'export class BookstoreGlspState extends FullTextHydraniumGlspState<BookstoreModel> {}'
      );
      // The diagram type is read from the language id, so the two cannot drift.
      expect(contentOf(files, 'protocol/src/bookstore-diagram-types.ts')).toContain(
         'export const BOOKSTORE_DIAGRAM_TYPE = BOOKSTORE_LANGUAGE.languageId;'
      );
   });

   it('emits a diagram only for the marked grammar', () => {
      const files = planInitFiles(
         resolveInitComposition('OrderFlow', [{ name: 'Domain' }, { name: 'Process', diagram: true }], ['lsp', 'data', 'glsp'])
      );
      const glspPaths = files.map(file => file.path).filter(path => path.startsWith('server/src/glsp/'));
      expect(glspPaths.every(path => path.startsWith('server/src/glsp/process/'))).toBe(true);
      expect(glspPaths).toHaveLength(7);
      expect(contentOf(files, 'server/src/main.ts')).toContain('.configureDiagramModule(new ProcessDiagramModule())');
   });

   it('starts the socket heads on a workspace and prints their ports without the LSP head', () => {
      const files = filesFor(['data', 'glsp']);
      const main = contentOf(files, 'server/src/main.ts') ?? '';
      expect(main).not.toContain('startLanguageServer');
      expect(main).not.toContain('publishPortOnLspConnection');
      expect(main).toContain('const { shared } = createBookstoreServices({ ...NodeFileSystem });');
      expect(main).toContain("port: portFrom('data-server-port', BOOKSTORE_DATA_SERVER_PORT_ENV)");
      expect(main).toContain("port: portFrom('glsp-server-port', BOOKSTORE_GLSP_SERVER_PORT_ENV)");
      expect(main).toContain('JSON.stringify({ dataServer: dataServer.port, glspServer: glspServer.port })');
      expect(contentOf(files, 'protocol/src/head-ports.ts')).toContain(
         "export const BOOKSTORE_GLSP_SERVER_PORT_ENV = 'BOOKSTORE_GLSP_SERVER_PORT';"
      );
      expect(contentOf(files, 'protocol/src/head-ports.ts')).not.toContain('_PORT_COMMAND');
      // No `--stdio`, which the strict flag parse refuses, and the starter
      // workspace rather than the server package as the cwd.
      expect(contentOf(files, 'server/package.json')).toContain('"start": "node lib/main.js ../workspace",');
   });

   it('keeps the stdio data entry beside the socket one for --heads data', () => {
      const files = filesFor(['data']);
      expect(contentOf(files, 'server/src/main.ts')).toContain('JSON.stringify({ dataServer: dataServer.port })');
      expect(contentOf(files, 'server/src/data-server-main.ts')).toContain('startStdioServer');
   });

   it('emits the base framework dependencies whatever the head set', () => {
      const manifest = JSON.parse(contentOf(filesFor(['data']), 'server/package.json') ?? '{}') as { dependencies: Record<string, string> };
      expect(Object.keys(manifest.dependencies)).toEqual(
         expect.arrayContaining(['@hydranium/core', '@hydranium/langium', '@hydranium/protocol', 'langium', 'vscode-languageserver'])
      );
   });

   it('leaves no unsubstituted token in any emitted head combination', () => {
      for (const heads of [
         ['lsp'],
         ['lsp', 'data'],
         ['lsp', 'glsp'],
         ['lsp', 'data', 'glsp'],
         ['data'],
         ['glsp'],
         ['data', 'glsp']
      ] as InitHead[][]) {
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
            'package.json',
            'protocol/.gitignore',
            'protocol/README.md',
            'protocol/package.json',
            'protocol/src/head-ports.ts',
            'protocol/src/index.ts',
            'protocol/tsconfig.json',
            'server/.gitignore',
            'server/README.md',
            'server/langium-config.json',
            'server/package.json',
            'server/src/data-server-main.ts',
            'server/src/grammar/bookstore.langium',
            'server/src/index.ts',
            'server/src/language-server/ast.ts',
            'server/src/language-server/bookstore-module.ts',
            'server/src/language-server/bookstore-serializer.ts',
            'server/src/main.ts',
            'server/src/node/services.ts',
            'server/test/linking.test.ts',
            'server/test/parsing.test.ts',
            'server/test/serialization.test.ts',
            'server/test/services.test.ts',
            'server/test/tsconfig.json',
            'server/test/validating.test.ts',
            'server/tsconfig.json',
            'server/tsconfig.test.json',
            'server/vitest.config.ts',
            'workspace/nodes.bookstore',
            'workspace/references.bookstore'
         ].sort()
      );
   });

   it('leaves no unsubstituted __TOKEN__ in any generated file', () => {
      for (const file of files) {
         expect(file.content, `${file.path} still has a token`).not.toMatch(/__[A-Z_]+__/);
      }
   });

   it('substitutes the name into the module, config, and grammar content', () => {
      expect(byPath('server/src/language-server/bookstore-module.ts')?.content).toContain('export function createBookstoreServices(');
      expect(byPath('server/src/language-server/bookstore-module.ts')?.content).toContain('BookstoreGeneratedModule');
      expect(byPath('server/langium-config.json')?.content).toContain('"projectName": "Bookstore"');
      expect(byPath('server/langium-config.json')?.content).toContain('".bookstore"');
      expect(byPath('server/src/grammar/bookstore.langium')?.content).toContain('grammar Bookstore');
   });

   it('gives the lone grammar its own prefixed rules and inline terminals', () => {
      const grammar = byPath('server/src/grammar/bookstore.langium')?.content;
      expect(grammar).toContain('entry BookstoreModel:');
      expect(grammar).toContain('(nodes+=BookstoreNode)*;');
      expect(grammar).toContain('BookstoreNode:');
      // No fragment to import when there is nothing to share it with.
      expect(grammar).toContain('terminal ID:');
      expect(grammar).not.toContain("import './common'");
      expect(byPath('server/src/grammar/common.langium')).toBeUndefined();
   });

   it('points services.js at the substituted module filename', () => {
      expect(byPath('server/src/node/services.ts')?.content).toContain("from '../language-server/bookstore-module.js'");
   });

   it('makes the package entry the barrel, not the server launcher', () => {
      // `main.ts` opens an LSP connection at module scope, so pointing `main`
      // at it would start a server as an import side effect.
      expect(byPath('server/package.json')?.content).toContain('"main": "lib/index.js"');
      expect(byPath('server/package.json')?.content).toContain('"bookstore": "lib/main.js"');
      expect(byPath('server/src/index.ts')?.content).not.toContain('./main.js');
   });

   /**
    * The key order Oxfmt's `sortPackageJson` canonicalises to, rendered WITH
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
            file => file.path === 'server/package.json'
         )?.content ?? '';

      expect(Object.keys(JSON.parse(manifest) as Record<string, unknown>)).toEqual([
         'name',
         'version',
         'private',
         'description',
         'keywords',
         'license',
         'author',
         'bin',
         'files',
         'type',
         'main',
         'types',
         'exports',
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
      const manifest = JSON.parse(byPath('server/package.json')?.content ?? '{}') as { files?: string[]; bin?: Record<string, string> };
      const targets = Object.values(manifest.bin ?? {});
      const covered = targets.filter(target => (manifest.files ?? []).includes(target.split('/')[0]));

      expect(byPath('server/.gitignore')?.content).toContain('lib/');
      // Named as a set rather than counted, so it cannot pass on an empty `bin`.
      expect(covered).toEqual(targets);
      expect(targets.length).toBeGreaterThan(0);
   });

   it('scaffolds a runnable test setup, not just source', () => {
      expect(byPath('server/package.json')?.content).toContain('"test": "npm run typecheck:test && vitest run"');
      expect(byPath('server/test/services.test.ts')?.content).toContain("from '../src/node/services.js'");
      expect(byPath('server/vitest.config.ts')?.content).toContain("include: ['test/**/*.{test,spec}.ts']");
   });

   it('types the single-grammar data head with that grammar’s transfer root', () => {
      expect(byPath('server/src/main.ts')?.content).toContain('new DataServer<BookstoreModel>(dataConnection, shared)');
   });

   it('separates the shared and per-language generated symbols by name role', () => {
      const split = planInitFiles(resolveInitComposition('OrderFlow', [{ name: 'Domain' }]));
      // The DI module is PROJECT-level — it composes every language and exports
      // `create<Name>Services` — so its filename follows the project id, not the
      // routing key, which now carries a grammar suffix.
      const module = split.find(file => file.path === 'server/src/language-server/order-flow-module.ts')?.content;

      // `projectName` drives the shared module, the grammar declaration the
      // per-language one. Conflating them only works while they are equal.
      expect(module).toContain("import { DomainGeneratedModule, OrderFlowGeneratedSharedModule } from './generated/module.js'");
      expect(module).toContain('generated: OrderFlowGeneratedSharedModule');
      expect(module).toContain('generated: DomainGeneratedModule');
      expect(module).toContain('return { shared, Domain: language };');
      // The grammar file follows the GRAMMAR, so a second grammar lands beside
      // it rather than needing the first one renamed.
      expect(split.find(file => file.path === 'server/src/grammar/domain.langium')?.content).toMatch(/^grammar Domain\n/);
   });

   it('keys the data-server port command by the project, not the language', () => {
      const split = planInitFiles(resolveInitComposition('OrderFlow', [{ name: 'Domain', languageId: 'order-flow-domain' }]));

      // One data server per process serves every registered grammar, so a
      // language-derived name would tie a project endpoint to the first grammar.
      const headPorts = split.find(file => file.path === 'protocol/src/head-ports.ts')?.content;
      expect(headPorts).toContain("ORDER_FLOW_DATA_SERVER_PORT_COMMAND = 'order-flow/data-server/port'");

      // The literal lives ONLY there, in the package a host imports without the
      // server: `main.ts` is an executable entry, so a constant declared in it
      // is unreachable to the host that must name it.
      expect(headPorts).toContain('export const');
      expect(split.find(file => file.path === 'server/src/main.ts')?.content).not.toContain("'order-flow/data-server/port'");
      expect(split.find(file => file.path === 'protocol/src/index.ts')?.content).toContain("export * from './head-ports.js'");
      expect(split.find(file => file.path === 'server/src/index.ts')?.content).not.toContain('head-ports');
   });

   it('asks langium-cli for a TextMate grammar, and gitignores the output', () => {
      expect(byPath('server/langium-config.json')?.content).toContain('"out": "syntaxes/bookstore.tmLanguage.json"');
      expect(byPath('server/.gitignore')?.content).toContain('syntaxes/');
      expect(byPath('server/package.json')?.content).toContain('rimraf lib syntaxes');
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

describe('planInitFiles project members', () => {
   const filesFor = (heads?: readonly InitHead[]): InitFile[] => planInitFiles(resolveInitComposition('Bookstore', undefined, heads));
   const contentOf = (files: readonly InitFile[], path: string): string => files.find(file => file.path === path)?.content ?? '';
   const manifestOf = (files: readonly InitFile[], path: string): Record<string, unknown> =>
      JSON.parse(contentOf(files, path)) as Record<string, unknown>;

   it('gives a standalone project a private root listing its packages', () => {
      const root = manifestOf(filesFor(), 'package.json');
      expect(root).toMatchObject({ name: 'bookstore-root', private: true, workspaces: ['protocol', 'server'] });
      expect(contentOf(filesFor(), '.gitignore')).toBe('node_modules/\n');
   });

   it('keeps the server root free of the Node-only services, behind ./node', () => {
      const files = filesFor();
      expect(manifestOf(files, 'server/package.json').exports).toEqual({
         '.': { types: './lib/index.d.ts', default: './lib/index.js' },
         './node': { types: './lib/node/services.d.ts', default: './lib/node/services.js' },
         // A host spawning the server resolves `<server>/lib/main.js`.
         './lib/*': './lib/*',
         './package.json': './package.json'
      });
      expect(contentOf(files, 'server/src/index.ts')).not.toContain('services');
   });

   it('pins the protocol member exactly, so the workspace links it rather than fetching it', () => {
      const dependencies = manifestOf(filesFor(), 'server/package.json').dependencies as Record<string, string>;
      expect(dependencies['bookstore-protocol']).toBe('0.0.0');
   });

   it('generates into protocol and builds it through the server’s project reference', () => {
      const files = filesFor();
      const scripts = manifestOf(files, 'server/package.json').scripts as Record<string, string>;
      expect(scripts.build).toBe('npm run generate && tsc -b');
      expect(scripts['generate:transfer-model']).toContain('--out-file ../protocol/src/generated-hydranium/transfer-model.ts');
      expect(scripts['generate:transfer-model']).toContain('--languages-file ../protocol/src/generated-hydranium/languages.ts');
      // Run from the project root, where a bare `npm run` reaches the root manifest.
      expect(scripts['generate:transfer-model']).toContain('Run: npm --prefix server run generate:transfer-model');
   });

   it('runs the server’s generate before compiling protocol, so a dependency-ordered runner finds the generated modules', () => {
      const scripts = manifestOf(filesFor(), 'protocol/package.json').scripts as Record<string, string>;
      expect(scripts.build).toBe('npm --prefix ../server run generate && tsc -b');
   });

   it('gives protocol a GLSP dependency only with the glsp head', () => {
      expect(manifestOf(filesFor(['lsp', 'data']), 'protocol/package.json').dependencies).toBeUndefined();
      expect(manifestOf(filesFor(['lsp', 'glsp']), 'protocol/package.json').dependencies).toEqual({ '@eclipse-glsp/protocol': '2.7.0' });
   });

   it('re-exports the generated modules from protocol, which init itself does not write', () => {
      const files = filesFor();
      expect(contentOf(files, 'protocol/src/index.ts')).toContain("export * from './generated-hydranium/transfer-model.js';");
      expect(files.filter(file => file.path.includes('generated-hydranium'))).toEqual([]);
   });

   it('writes two starter files per language, the second referencing the first', () => {
      const files = filesFor();
      expect(contentOf(files, 'workspace/nodes.bookstore')).toContain('node Second -> First');
      expect(contentOf(files, 'workspace/references.bookstore')).toContain('node Third -> Second');
      expect(contentOf(files, 'workspace/references.bookstore')).toContain('nodes.bookstore');
   });
});

describe('planInitFiles with several grammars', () => {
   const composition = resolveInitComposition('OrderFlow', [
      { name: 'Domain' },
      { name: 'Process' },
      { name: 'Layout', extensions: ['layout'] }
   ]);
   const files = planInitFiles(composition);
   const byPath = (path: string): string | undefined => files.find(file => file.path === path)?.content;

   it('emits one grammar file per grammar plus the shared fragment', () => {
      expect(files.map(file => file.path).filter(path => path.startsWith('server/src/grammar/'))).toEqual([
         'server/src/grammar/common.langium',
         'server/src/grammar/domain.langium',
         'server/src/grammar/process.langium',
         'server/src/grammar/layout.langium'
      ]);
   });

   it('moves the terminals into the fragment and imports it from each grammar', () => {
      expect(byPath('server/src/grammar/common.langium')).toContain('terminal ID:');
      for (const grammarId of ['domain', 'process', 'layout']) {
         const grammar = byPath(`server/src/grammar/${grammarId}.langium`);
         expect(grammar, grammarId).toContain("import './common'");
         // Declaring them again in each grammar is what the fragment exists to
         // avoid — the token sets would drift apart.
         expect(grammar, grammarId).not.toContain('terminal ID:');
      }
   });

   it('gives each grammar its own entry rule so the combined ast.ts has no collision', () => {
      expect(byPath('server/src/grammar/domain.langium')).toContain('entry DomainModel:');
      expect(byPath('server/src/grammar/process.langium')).toContain('entry ProcessModel:');
      expect(byPath('server/src/grammar/layout.langium')).toContain('entry LayoutModel:');
   });

   it('registers every language in one langium-config, with its own extension', () => {
      const config = byPath('server/langium-config.json');
      expect(config).toContain('"id": "order-flow-domain"');
      expect(config).toContain('"id": "order-flow-process"');
      expect(config).toContain('"id": "order-flow-layout"');
      expect(config).toContain('"fileExtensions": [".layout"]');
      // One config, one projectName: `AstReflection` is a single shared slot.
      expect(config?.match(/"projectName"/g)).toHaveLength(1);
   });

   it('composes the further grammars through additionalLanguages', () => {
      const module = byPath('server/src/language-server/order-flow-module.ts');
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
      const module = byPath('server/src/language-server/order-flow-module.ts');
      expect(module).toContain("export const ORDER_FLOW_CONFIGURATION_ROOT = 'order-flow';");
      expect(module).toContain('configurationRoot: () => ORDER_FLOW_CONFIGURATION_ROOT');
   });

   it('types the data head with the union of every transfer root', () => {
      // One data server per process serves every grammar.
      expect(byPath('server/src/main.ts')).toContain('new DataServer<DomainModel | LayoutModel | ProcessModel>(dataConnection, shared)');
      expect(byPath('server/src/main.ts')).toContain("import type { DomainModel, LayoutModel, ProcessModel } from 'order-flow-protocol';");
   });

   it('leaves the diagnostics provider to the platform default', () => {
      // A scaffolded host is a Node host and gets the real implementation with
      // no wiring, because the default is selected by the data-server package's
      // `browser` field. Asserted as an ABSENCE so the scaffold cannot quietly
      // regrow a line every adopter would have to understand and none needs.
      expect(byPath('server/src/main.ts')).not.toContain('nodeDataServerDiagnostics');
      expect(byPath('server/src/main.ts')).not.toContain('diagnostics:');
   });

   it('asserts every registered language in the scaffolded test', () => {
      const test = byPath('server/test/services.test.ts');
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
      expect(captured?.files).toHaveLength(31);
      // `path.join`, not a literal: the target is produced by `path.resolve`,
      // which emits the platform separator, so a hardcoded `/` asserts nothing
      // on Windows beyond the separator itself.
      expect(captured?.targetDir.endsWith(path.join('out', 'bookstore'))).toBe(true);
      const output = lines.join('');
      expect(output).toContain('Scaffolded Bookstore (31 files, heads: lsp,data, 1 grammar(s): Bookstore)');
      expect(output).toContain('npm run build');
      expect(output).toContain('npm test');
      // `npx`, not a bare invocation: the scaffold installs `@hydranium/cli` as a
      // devDependency, so a bare command resolves only with a global install.
      expect(output).toContain('  npx hydranium-cli reflect --services ./server/lib/node/services.js\n');
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
      // 31 single-grammar files + two further grammars, their two serializers,
      // the shared fragment and two starter files each.
      expect(captured?.files).toHaveLength(40);
      expect(lines.join('')).toContain('Scaffolded OrderFlow (40 files, heads: lsp,data, 3 grammar(s): Domain, Process, Layout)');
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
      // 40 multi-grammar files + the nine for the one diagram: seven in the
      // server, its test, and its ids in protocol.
      expect(captured?.files).toHaveLength(49);
      expect(lines.join('')).toContain(
         'Scaffolded OrderFlow (49 files, heads: lsp,data,glsp, 3 grammar(s): Domain, Process (diagram), Layout)'
      );
   });
});

/**
 * `--monorepo`, over an in-memory workspace: what the templates DO with the
 * detected workspace facts, which is the part an adopter sees.
 *
 * The detection rules have their own suite; a placement is supplied directly
 * here so neither half can pass by leaning on the other.
 */
describe('planInitFiles with detected workspace facts', () => {
   const plan = (workspace: {
      printWidth?: number;
      eslintConfig?: string;
      oxlintConfig?: string;
      packageManagerNpm?: string;
      npmVersion?: string;
   }): readonly InitFile[] =>
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
         contentOf(files, 'server/src/glsp/bookstore/diagram-module.ts')
            .split('\n')
            .filter(line => line.startsWith('import') || line.startsWith('   ') || line.startsWith('} from')).length;

      expect(importLines(plan({ printWidth: 400 }))).toBeLessThan(importLines(plan({ printWidth: 60 })));
   });

   it('falls back to the scaffold budget when the workspace pins no width', () => {
      // Byte-identical to an explicit 120, which is what "falls back" has to
      // mean; asserting merely that it renders would pass at any width.
      const main = contentOf(plan({}), 'server/src/main.ts');
      expect(main).not.toBe('');
      expect(main).toBe(contentOf(plan({ printWidth: 120 }), 'server/src/main.ts'));
   });

   it('emits the Oxlint command in a migrated workspace, from each member one level below the project', () => {
      const files = plan({ oxlintConfig: 'oxlint.config.cjs' });
      expect(contentOf(files, 'server/package.json')).toContain(
         '"lint": "oxlint --report-unused-disable-directives --format stylish --config ../../../oxlint.config.cjs src test --max-warnings 0"'
      );
      expect(contentOf(files, 'protocol/package.json')).toContain(
         '"lint": "oxlint --report-unused-disable-directives --format stylish --config ../../../oxlint.config.cjs src --max-warnings 0"'
      );
   });

   it('emits a lint script only where the workspace has an eslint config', () => {
      expect(contentOf(plan({ eslintConfig: 'eslint.config.js' }), 'server/package.json')).toContain(
         '"lint": "eslint src test --max-warnings 0"'
      );
      const unlinted = plan({});
      expect(contentOf(unlinted, 'server/package.json')).toContain('"scripts"');
      expect(contentOf(unlinted, 'server/package.json')).not.toContain('"lint"');
      expect(contentOf(unlinted, 'protocol/package.json')).not.toContain('"lint"');
   });

   const vitestOf = (files: readonly InitFile[]): string | undefined =>
      (JSON.parse(contentOf(files, 'server/package.json')) as { devDependencies: Record<string, string> }).devDependencies.vitest;

   /** npm before 11.6 crashes on vitest 4.1's peer set during the first install. */
   it('holds vitest below 4.1 in a standalone project', () => {
      const standalone = planInitFiles(resolveInitComposition('Bookstore', undefined, ['lsp']));
      expect(vitestOf(standalone)).toBe('~4.0.18');
      expect(contentOf(standalone, 'server/README.md')).toContain('`vitest` is held below 4.1');
      expect(vitestOf(plan({}))).toBe('~4.0.18');
   });

   /** npm does not enforce `packageManager`, so a root declaring 11.15 can still be installed with Node 22's 10.9; an unknown npm keeps the pin. */
   it.each([
      ['11.5.2', '10.9.3', '~4.0.18'],
      ['11.5.2', '11.6.0', '~4.0.18'],
      ['11.5.2', '11.15.0', '~4.0.18'],
      ['11.5.2', undefined, '~4.0.18'],
      ['11.6.0', '10.9.3', '~4.0.18'],
      ['11.6.0', '11.6.0', '^4.0.0'],
      ['11.6.0', '11.15.0', '^4.0.0'],
      ['11.6.0', undefined, '~4.0.18'],
      ['11.15.0', '10.9.3', '~4.0.18'],
      ['11.15.0', '11.6.0', '^4.0.0'],
      ['11.15.0', '11.15.0', '^4.0.0'],
      ['11.15.0', undefined, '~4.0.18'],
      ['11.15.0', '11.6.0-rc.1', '~4.0.18'],
      ['11.6.0-rc.1', '11.15.0', '~4.0.18'],
      ['11.15.0', '11.6.1-rc.1', '^4.0.0'],
      ['12.0.0', '12.0.0', '^4.0.0']
   ])('emits vitest for a root declaring npm %s and init running under npm %s as %s', (packageManagerNpm, npmVersion, expected) => {
      const files = plan({ packageManagerNpm, npmVersion });
      expect(vitestOf(files)).toBe(expected);
      expect(contentOf(files, 'server/README.md').includes('`vitest` is held below 4.1')).toBe(expected === '~4.0.18');
   });

   it('inherits every option tsc reads case-insensitively, spelled in lowercase', () => {
      const files = planInitFiles(
         resolveInitComposition('MyLang', undefined, ['lsp'], {
            private: true,
            workspace: {
               targetPath: 'packages/my-lang',
               baseTsconfig: '../../tsconfig.json',
               baseCompilerOptions: { target: 'es2022', lib: ['es2022'], module: 'nodenext', moduleResolution: 'nodenext' }
            }
         })
      );
      const options = Object.keys((JSON.parse(contentOf(files, 'server/tsconfig.json')) as { compilerOptions: object }).compilerOptions);
      expect(options.filter(option => ['target', 'lib', 'module', 'moduleResolution'].includes(option))).toEqual([]);
   });
});

describe('runInit --monorepo into a yo langium root', () => {
   // The root `generator-langium` 4.4.0 writes, without its sources: an
   // options-carrying `tsconfig.json` beside a solution `tsconfig.build.json`,
   // an enumerated `workspaces` list, and a `.gitignore` of its own.
   const ROOT = fileURLToPath(new URL('./fixtures/yo-langium-root/', import.meta.url));

   function scaffold(heads?: readonly InitHead[]): { files: readonly InitFile[]; output: string } {
      const lines: string[] = [];
      let captured: readonly InitFile[] = [];
      runInit({
         targetDir: path.join(ROOT, 'packages/my-lang'),
         name: 'MyLang',
         heads,
         monorepo: true,
         probe: createNodeWorkspaceProbe(),
         write: line => lines.push(line),
         __writeFilesForTest: (_targetDir, files) => {
            captured = files;
         }
      });
      return { files: captured, output: lines.join('') };
   }

   it('inherits the options the root supplies, whatever case it spells them in', () => {
      expect(scaffold().files.find(file => file.path === 'server/tsconfig.json')?.content).toBe(
         `{
  "extends": "../../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib",
    "target": "ES2022",
    "lib": ["ES2022"],
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src", "src/**/*.json"],
  "references": [{ "path": "../protocol" }]
}
`
      );
   });

   it('names an entry per package for an enumerated workspaces list', () => {
      expect(scaffold().output).toContain('Add these to "workspaces"');
      expect(scaffold().output).toContain('    "packages/my-lang/protocol",\n    "packages/my-lang/server"\n');
   });

   // The fixture's language package declares `langium ~4.4.0`, which an installed yo root holds at the top.
   it('names the exact pins the root has to declare to keep the shared copies at the top', () => {
      expect(scaffold().output).toContain(
         "package.json, so another member's version of one cannot displace the copy these packages share with the framework:\n" +
            '    "langium": "4.3.1",\n' +
            '    "vscode-jsonrpc": "9.0.0",\n' +
            '    "vscode-languageserver": "10.0.1",\n' +
            '    "vscode-languageserver-protocol": "3.18.1"\n'
      );
   });

   it('adds the GLSP pins for the GLSP head, the protocol member’s included, but no range', () => {
      const { output } = scaffold(['lsp', 'glsp']);
      expect(output).toContain(
         '    "@eclipse-glsp/graph": "2.7.0",\n    "@eclipse-glsp/protocol": "2.7.0",\n    "@eclipse-glsp/server": "2.7.0",\n    "langium": "4.3.1",\n'
      );
      expect(output).not.toContain('inversify');
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
    * - absent from the base (`lib`, `resolveJsonModule`, `skipLibCheck`, …) → kept.
    *
    * A base config that happened to supply everything would show only the first.
    */
   it('extends the base config and keeps only the options it does not inherit', () => {
      const tsconfig = contentOf(scaffold().files, 'server/tsconfig.json');
      expect(tsconfig).toBe(
         `{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "declaration": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "src/**/*.json"],
  "references": [{ "path": "../protocol" }]
}
`
      );
      // The per-package paths lead, and never come from a base: one that
      // supplied them would be pointing every member at one directory.
      expect(tsconfig).not.toContain('"target"');
      expect(tsconfig).not.toContain('"strict"');
   });

   it.each([
      [undefined, '~4.0.18'],
      ['pnpm/9.0.0 npm/? node/v22.18.0 linux x64', '~4.0.18'],
      ['npm/11.15.0 node/v22.18.0 linux x64 workspaces/false', '^4.0.0'],
      ['npm/11.6.0-rc.1 node/v22.18.0 linux x64 workspaces/false', '~4.0.18'],
      ['npm/10.9.2 node/v22.13.0 linux x64 workspaces/false', '~4.0.18']
   ])("takes the vitest range from the root's packageManager and the npm user agent %s", (userAgent, expected) => {
      vi.stubEnv('npm_config_user_agent', userAgent);
      try {
         expect(contentOf(scaffold().files, 'server/package.json')).toContain('"vitest": "~4.0.18"');

         const rootManifest = path.join(ROOT, 'package.json');
         const declaringNpm: Record<string, JsonValue> = {
            ...TREE,
            [rootManifest]: { ...(TREE[rootManifest] as Record<string, JsonValue>), packageManager: 'npm@11.15.0' }
         };
         let captured: readonly InitFile[] = [];
         runInit({
            targetDir: TARGET,
            name: 'Bookstore',
            monorepo: true,
            probe: { ...probe, readJson: filePath => declaringNpm[filePath] },
            write: () => undefined,
            __writeFilesForTest: (_targetDir, files) => {
               captured = files;
            }
         });
         expect(contentOf(captured, 'server/package.json')).toContain(`"vitest": "${expected}"`);
      } finally {
         vi.unstubAllEnvs();
      }
   });

   it('writes the .gitignore a standalone project gets, whatever the root ignores', () => {
      const { files } = scaffold();
      // A standalone scaffold's files, less the root it has no use for here.
      expect(files).toHaveLength(29);
      expect(contentOf(files, 'package.json')).toBeUndefined();
      const standalone = planInitFiles(resolveInitComposition('Bookstore', undefined, ['lsp']));
      expect(contentOf(files, 'server/.gitignore')).toBe(contentOf(standalone, 'server/.gitignore'));
   });

   it('scopes every package name and addresses the server by --prefix', () => {
      const { files } = scaffold({ scope: '@acme' });
      const server = contentOf(files, 'server/package.json');
      expect(server).toContain('"name": "@acme/bookstore-server"');
      expect(server).toContain('"@acme/bookstore-protocol": "0.0.0"');
      expect(contentOf(files, 'protocol/package.json')).toContain('"name": "@acme/bookstore-protocol"');
      // A workspace member's scripts get run from the repo root, where a bare
      // `npm run` would reach the ROOT manifest.
      expect(server).toContain('Run: npm --prefix packages/bookstore/server run generate:transfer-model');
   });

   /**
    * The manifest's `private` and `license` are one decision: the emitted
    * `license` is UNLICENSED, so a publishable default would grant no rights on
    * a public registry. Asserted in both directions because either alone passes
    * with the substitution stuck at one value.
    */
   it('withholds publication by default and releases it only for --public, for every package', () => {
      // Both or neither: a published server depending on an unpublished
      // protocol member installs nowhere.
      for (const member of ['server', 'protocol']) {
         const byDefault = contentOf(scaffold().files, `${member}/package.json`);
         expect(byDefault, member).toContain(`"name": "bookstore-${member}"`);
         expect(byDefault, member).toContain('"private": true');
         expect(byDefault, member).toContain('"license": "UNLICENSED"');

         const published = contentOf(scaffold({ public: true }).files, `${member}/package.json`);
         expect(published, member).toContain(`"name": "bookstore-${member}"`);
         expect(published, member).not.toContain('"private"');
      }
   });

   /**
    * Detection knows the sibling scope, but does not APPLY it: the emitted
    * package name stays a function of the argv alone, which is what lets the
    * wizard's echoed command reproduce the scaffold anywhere.
    */
   it('suggests the siblings’ scope rather than adopting it', () => {
      const { files, output } = scaffold();
      expect(contentOf(files, 'server/package.json')).toContain('"name": "bookstore-server"');
      expect(output).toContain('pass --scope @acme to match them');
   });

   it('says each package is already covered, and still asks the root for its pins', () => {
      const rootManifest = path.join(ROOT, 'package.json');
      const nested: Record<string, JsonValue> = { ...TREE, [rootManifest]: { name: 'repo-root', workspaces: ['packages/*/*'] } };
      const lines: string[] = [];
      runInit({
         targetDir: TARGET,
         name: 'Bookstore',
         monorepo: true,
         probe: { ...probe, readJson: filePath => nested[filePath] },
         write: line => lines.push(line),
         __writeFilesForTest: () => undefined
      });
      const output = lines.join('');
      expect(output).toContain(
         '  packages/bookstore/protocol is already covered by the "packages/*/*" workspaces entry.\n' +
            '  packages/bookstore/server is already covered by the "packages/*/*" workspaces entry.\n' +
            '  Add these to "devDependencies"'
      );
      expect(output).not.toContain('to "workspaces"');
   });

   it('prints an entry per package when no glob reaches one level below the target', () => {
      // `packages/*` reaches the project directory, which holds no package.
      expect(scaffold().output).toContain('Add these to "workspaces"');
      expect(scaffold().output).toContain('    "packages/bookstore/protocol",\n    "packages/bookstore/server"\n');
   });

   it('runs the next steps from the workspace root, naming the server by --prefix', () => {
      const { output } = scaffold();
      expect(output).toContain(`  cd ${ROOT}\n  npm install\n  npm --prefix packages/bookstore/server run build`);
      expect(output).toContain('npx hydranium-cli reflect --services ./packages/bookstore/server/lib/node/services.js\n');
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
