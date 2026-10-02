#!/usr/bin/env node
/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Subclass-API gate: every type named by a member an adopter can override must
 * be importable from the package's own entry points.
 *
 * A `protected` member is part of the subclass API. When its signature names a
 * type the package does not export, an override cannot name that type and has
 * to restate the shape structurally instead. That compiles, so nothing goes
 * red — until a field is added to the real type, and then the restatement stops
 * matching. Every consumer that type-checks against `src` breaks at once, which
 * is every test tree in this repo: they import `../../src/...` rather than the
 * package name. A single sweep found nine of these across three packages, one
 * of which had already broken two in-repo subclasses exactly that way.
 *
 * Reads `src`, and reading the BUILT `lib/**\/*.d.ts` instead does not work
 * however much it looks like the adopter's own view. TypeScript treats a
 * top-level declaration in a `.d.ts` MODULE as exported whether or not it
 * carries the `export` keyword, so `getExportsOfModule` over a declaration file
 * reports the module-private types and the public ones identically, an
 * `export *` barrel propagates both, and the gate goes green on a tree where
 * every one of these defects is present. The distinction this gate exists to
 * make survives only in source.
 *
 * Reachability is computed with `getExportsOfModule` from the `src` file behind
 * each entry point named in the package's `exports` map, so a re-export chain
 * of any depth counts and a module that merely looks exported in its own file
 * does not. A cross-package reference resolves into the DECLARING package's
 * `lib`, so declarations are keyed by source file and name rather than by
 * identity, which lets a `lib` hit be tested against its `src` original.
 *
 * Members with no annotation are checked against their INFERRED type, since a
 * subclass restating one still has to name whatever it infers to.
 *
 * Only NAMED declarations are reported. An anonymous type literal in a
 * signature is already written inline, so an override restates it from the
 * signature it is overriding and cannot drift from a declaration that does not
 * exist. That is what keeps this gate free of an allowlist.
 *
 * It SELF-TESTS, because a reachability check that has stopped discriminating
 * reports a clean subclass API and reads exactly like a clean repository.
 *
 * Usage: node scripts/check-protected-signatures.mts
 */

import ts from 'typescript-api';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

type NamedTypeDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.ClassDeclaration | ts.EnumDeclaration;

/** The fields of a package manifest this gate reads. */
interface PackageManifest {
   name: string;
   exports?: unknown;
   types?: unknown;
}

interface PublishedPackage {
   directory: string;
   name: string;
   entries: string[];
}

/** A report label and the annotation in that slot, `undefined` when the slot is inferred. */
type SignatureSlot = [label: string, typeNode: ts.TypeNode | undefined];

interface Finding {
   package: string;
   member: string;
   slot: string;
   type: string;
   declaredIn: string;
   line: number;
   file: string;
}

/** Declaration kinds an adopter has to name. A type literal is written inline and is not one. */
function isNamedTypeDeclaration(node: ts.Node): node is NamedTypeDeclaration {
   return ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node);
}

/**
 * The `src` files behind a package's published entry points, read from its
 * `exports` map rather than assumed to be `index.ts`. A subpath entry is a
 * first-class import site, so a type reachable only from `./testing` is
 * reachable, and one reachable from no entry is not however exported its own
 * file leaves it.
 */
function entryPointsOf(packageDir: string): { name: string; entries: string[] } {
   const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as PackageManifest;
   const entries = new Set<string>();
   const collect = (node: unknown): void => {
      if (typeof node === 'string') {
         if (node.endsWith('.d.ts')) {
            const source = join(
               packageDir,
               'src',
               node
                  .replace(/^\.\//, '')
                  .replace(/^lib\//, '')
                  .replace(/\.d\.ts$/, '.ts')
            );
            entries.add(source);
         }
         return;
      }
      if (node && typeof node === 'object') {
         for (const value of Object.values(node)) {
            collect(value);
         }
      }
   };
   collect(manifest.exports ?? {});
   collect(manifest.types ?? {});
   return { name: manifest.name, entries: [...entries] };
}

/** Workspace packages that publish at least one typed entry point. */
function publishedPackages(): PublishedPackage[] {
   return readdirSync(PACKAGES_DIR)
      .map(entry => join(PACKAGES_DIR, entry))
      .filter(directory => existsSync(join(directory, 'package.json')))
      .map(directory => ({ directory, ...entryPointsOf(directory) }))
      .filter(pkg => pkg.entries.length > 0);
}

/** Build a context that can answer which package owns a file and where its source lives. */
function locator(packages: PublishedPackage[]): {
   owningPackage: (file: string) => PublishedPackage | undefined;
   keyOf: (declaration: ts.NamedDeclaration) => string;
} {
   const owningPackage = (file: string): PublishedPackage | undefined => {
      for (const pkg of packages) {
         if (file.startsWith(join(pkg.directory, 'src') + sep) || file.startsWith(join(pkg.directory, 'lib') + sep)) {
            return pkg;
         }
      }
      return undefined;
   };

   /**
    * The `src` file a declaration really lives in. A cross-package reference
    * resolves into the other package's `lib`, and the two trees have to agree
    * on one key or a type exported from its own package reads as unreachable
    * everywhere it is consumed.
    */
   const toSource = (file: string): string => {
      const owner = owningPackage(file);
      if (!owner || !file.startsWith(join(owner.directory, 'lib') + sep)) {
         return file;
      }
      const candidate = join(owner.directory, 'src', relative(join(owner.directory, 'lib'), file).replace(/\.d\.ts$/, '.ts'));
      return existsSync(candidate) ? candidate : file;
   };

   const keyOf = (declaration: ts.NamedDeclaration): string =>
      `${toSource(declaration.getSourceFile().fileName)}#${declaration.name?.getText?.() ?? '(anonymous)'}`;
   return { owningPackage, keyOf };
}

/**
 * Every type reference in a signature, including the ones nested in generic
 * arguments, unions and `typeof` queries.
 */
function typeReferencesIn(node: ts.Node): (ts.EntityName | ts.Expression)[] {
   const found: (ts.EntityName | ts.Expression)[] = [];
   const visit = (child: ts.Node): void => {
      if (ts.isTypeReferenceNode(child)) {
         found.push(child.typeName);
      } else if (ts.isTypeQueryNode(child)) {
         found.push(child.exprName);
      } else if (ts.isImportTypeNode(child) && child.qualifier) {
         found.push(child.qualifier);
      } else if (ts.isExpressionWithTypeArguments(child) && child.expression) {
         found.push(child.expression);
      }
      ts.forEachChild(child, visit);
   };
   visit(node);
   return found;
}

/** Named declarations inside an inferred type, walking unions, aliases and type arguments. */
function namedDeclarationsOfType(
   type: ts.Type | undefined,
   checker: ts.TypeChecker,
   seen = new Set<number>(),
   depth = 0
): NamedTypeDeclaration[] {
   if (!type || depth > 4) {
      return [];
   }
   const id = typeIdOf(type);
   if (id !== undefined) {
      if (seen.has(id)) {
         return [];
      }
      seen.add(id);
   }
   const found: NamedTypeDeclaration[] = [];
   for (const symbol of [type.aliasSymbol, type.getSymbol()]) {
      if (!symbol) {
         continue;
      }
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      found.push(...(target.getDeclarations() ?? []).filter(isNamedTypeDeclaration));
   }
   for (const part of constituentsOf(type)) {
      found.push(...namedDeclarationsOfType(part, checker, seen, depth + 1));
   }
   // Both lists: `getTypeArguments` answers `[]`, not undefined, for an alias
   // instantiation such as `Box<Hidden>`, whose arguments only the alias carries.
   for (const argument of [...checker.getTypeArguments(type as ts.TypeReference), ...(type.aliasTypeArguments ?? [])]) {
      found.push(...namedDeclarationsOfType(argument, checker, seen, depth + 1));
   }
   return found;
}

/** The checker's internal type id, which the public `ts.Type` does not declare. */
function typeIdOf(type: ts.Type): number | undefined {
   return 'id' in type && typeof type.id === 'number' ? type.id : undefined;
}

/** The `types` of a union, intersection or template literal: the kinds that carry one. */
function constituentsOf(type: ts.Type): readonly ts.Type[] {
   if (type.isUnionOrIntersection()) {
      return type.types;
   }
   return type.flags & ts.TypeFlags.TemplateLiteral ? (type as ts.TemplateLiteralType).types : [];
}

/** Whether a member is reachable by a subclass. */
function isSubclassVisible(member: ts.ClassElement): boolean {
   const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
   if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword)) {
      return false;
   }
   return !(member.name && ts.isPrivateIdentifier(member.name));
}

/**
 * The signature slots of one member, each labelled for the report. A slot with
 * no annotation carries `undefined` and is checked against its inferred type.
 */
function signatureSlotsOf(member: ts.ClassElement, source: ts.SourceFile): SignatureSlot[] {
   const slots: SignatureSlot[] = [];
   if (
      ts.isMethodDeclaration(member) ||
      ts.isConstructorDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
   ) {
      for (const parameter of member.parameters) {
         if (parameter.type) {
            slots.push([`parameter \`${parameter.name.getText(source)}\``, parameter.type]);
         }
      }
      if (!ts.isConstructorDeclaration(member)) {
         slots.push(['return type', member.type]);
      }
   } else if (ts.isPropertyDeclaration(member)) {
      slots.push(['type', member.type]);
   }
   return slots;
}

/** Declarations an adopter can name, keyed by source file and name. */
function reachableDeclarations(
   programs: Map<string, ts.Program>,
   packages: PublishedPackage[],
   keyOf: (declaration: ts.NamedDeclaration) => string
): { reachable: Set<string>; missing: string[] } {
   const reachable = new Set<string>();
   const missing: string[] = [];
   for (const pkg of packages) {
      const program = programs.get(pkg.directory)!;
      const checker = program.getTypeChecker();
      for (const entry of pkg.entries) {
         const source = program.getSourceFile(entry);
         if (!source) {
            missing.push(`${pkg.name} declares an entry point with no source: ${relative(REPO_ROOT, entry)}`);
            continue;
         }
         const moduleSymbol = checker.getSymbolAtLocation(source);
         if (!moduleSymbol) {
            continue;
         }
         for (const exported of checker.getExportsOfModule(moduleSymbol)) {
            const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
            for (const declaration of [...(target.getDeclarations() ?? []), ...(exported.getDeclarations() ?? [])]) {
               reachable.add(keyOf(declaration));
            }
         }
      }
   }
   return { reachable, missing };
}

/** Findings for one workspace: a subclass-visible member naming a type no entry point exports. */
function findUnnameableTypes(programs: Map<string, ts.Program>, packages: PublishedPackage[]): { findings: Finding[]; missing: string[] } {
   const { owningPackage, keyOf } = locator(packages);
   const { reachable, missing } = reachableDeclarations(programs, packages, keyOf);
   const findings: Finding[] = [];
   const seen = new Set<string>();

   const record = (
      pkg: PublishedPackage,
      source: ts.SourceFile,
      className: string,
      memberName: string,
      slot: string,
      typeName: string,
      declaration: NamedTypeDeclaration,
      at: ts.Node
   ): void => {
      if (!owningPackage(declaration.getSourceFile().fileName) || reachable.has(keyOf(declaration))) {
         return;
      }
      const key = `${source.fileName}|${className}|${memberName}|${slot}|${typeName}`;
      if (seen.has(key)) {
         return;
      }
      seen.add(key);
      findings.push({
         package: pkg.name,
         member: `${className}.${memberName}`,
         slot,
         type: typeName,
         declaredIn: owningPackage(declaration.getSourceFile().fileName)!.name,
         line: source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1,
         file: relative(REPO_ROOT, source.fileName)
      });
   };

   for (const pkg of packages) {
      const program = programs.get(pkg.directory)!;
      const checker = program.getTypeChecker();
      const sourceRoot = join(pkg.directory, 'src') + sep;
      for (const source of program.getSourceFiles()) {
         if (source.isDeclarationFile || !source.fileName.startsWith(sourceRoot)) {
            continue;
         }
         const visitClass = (declaration: ts.ClassDeclaration): void => {
            if (!reachable.has(keyOf(declaration))) {
               return;
            }
            const className = declaration.name?.text ?? '(anonymous)';
            for (const member of declaration.members) {
               if (!isSubclassVisible(member)) {
                  continue;
               }
               const memberName = member.name ? member.name.getText(source) : '(unnamed)';
               for (const [slot, typeNode] of signatureSlotsOf(member, source)) {
                  if (typeNode) {
                     for (const reference of typeReferencesIn(typeNode)) {
                        const symbol = checker.getSymbolAtLocation(reference);
                        if (!symbol) {
                           continue;
                        }
                        const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
                        for (const named of (target.getDeclarations() ?? []).filter(isNamedTypeDeclaration)) {
                           record(pkg, source, className, memberName, slot, reference.getText(source), named, reference);
                        }
                     }
                     continue;
                  }
                  const symbol = member.name && checker.getSymbolAtLocation(member.name);
                  if (!symbol) {
                     continue;
                  }
                  const memberType = checker.getTypeOfSymbolAtLocation(symbol, member);
                  const signature = memberType.getCallSignatures?.()[0];
                  const inferred = ts.isMethodDeclaration(member) ? signature && checker.getReturnTypeOfSignature(signature) : memberType;
                  for (const named of namedDeclarationsOfType(inferred, checker)) {
                     const label = `${slot} (inferred)`;
                     record(pkg, source, className, memberName, label, named.name?.getText() ?? '(anonymous)', named, member.name!);
                  }
               }
            }
         };
         const visit = (node: ts.Node): void => {
            if (ts.isClassDeclaration(node)) {
               visitClass(node);
            }
            ts.forEachChild(node, visit);
         };
         visit(source);
      }
   }
   return { findings, missing };
}

/** One program per package, over the sources its own tsconfig names. */
function programsFor(packages: PublishedPackage[]): Map<string, ts.Program> {
   const programs = new Map<string, ts.Program>();
   for (const pkg of packages) {
      const configPath = join(pkg.directory, 'tsconfig.json');
      const raw = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, pkg.directory);
      programs.set(
         pkg.directory,
         ts.createProgram(parsed.fileNames, {
            ...parsed.options,
            noEmit: true,
            composite: false,
            incremental: false,
            declaration: false,
            declarationMap: false
         })
      );
   }
   return programs;
}

/**
 * Proves the check still discriminates, on a synthetic pair differing in one
 * thing: whether the type the protected members name is re-exported from the
 * entry point. A gate that reports neither case is indistinguishable from a
 * clean tree, and this is the only thing that separates them. One member names
 * the type in its annotation and one only through an inferred alias
 * instantiation, since the two are found by different walks.
 *
 * The host serves no lib files, so a case built on a lib type such as `Array`
 * resolves to an error type and reports nothing in either variant.
 */
function selfTest() {
   const run = (exportTheType: boolean): Finding[] => {
      const sources = new Map([
         [
            '/probe/src/internal.ts',
            [
               'export interface Kept { a: string; }',
               `${exportTheType ? 'export ' : ''}interface Hidden { b: string; }`,
               'export type Box<T> = { value: T; };',
               'export class Base {',
               '   protected seam(): Hidden { return { b: "x" }; }',
               '   protected wrapped() { return { value: { b: "x" } } as Box<Hidden>; }',
               '}'
            ].join('\n')
         ],
         ['/probe/src/index.ts', "export * from './internal.js';"]
      ]);
      const options = { noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS };
      const host = ts.createCompilerHost(options);
      const readFile = host.readFile.bind(host);
      host.readFile = name => sources.get(name) ?? readFile(name);
      host.fileExists = name => sources.has(name) || existsSync(name);
      // Module resolution consults `directoryExists` before probing a folder,
      // so without this the re-export never resolves and BOTH cases report
      // nothing — the exact blindness this self-test exists to catch.
      host.directoryExists = name => name.startsWith('/probe') || existsSync(name);
      host.realpath = name => name;
      host.getSourceFile = (name, languageVersion) => {
         const text = sources.get(name);
         return text === undefined ? undefined : ts.createSourceFile(name, text, languageVersion, true, ts.ScriptKind.TS);
      };
      const program = ts.createProgram([...sources.keys()], options, host);
      const pkg = { name: 'probe', directory: '/probe', entries: ['/probe/src/index.ts'] };
      return findUnnameableTypes(new Map([['/probe', program]]), [pkg]).findings;
   };

   const hidden = run(false);
   const reportedMembers = hidden.map(finding => `${finding.member}:${finding.type}`).sort();
   if (reportedMembers.join(' ') !== 'Base.seam:Hidden Base.wrapped:Hidden') {
      throw new Error(`self-test: an unexported type named by a protected member must be reported, got ${JSON.stringify(hidden)}`);
   }
   const exported = run(true);
   if (exported.length !== 0) {
      throw new Error(`self-test: an exported type must not be reported, got ${JSON.stringify(exported)}`);
   }
   console.log('✓ self-test: an unexported type named by a protected member is reported');
   console.log('✓ self-test: the same type re-exported from the entry point is not');
}

function main() {
   selfTest();
   const packages = publishedPackages();
   const { findings, missing } = findUnnameableTypes(programsFor(packages), packages);

   for (const note of missing) {
      console.error(`✗ ${note}`);
   }
   if (findings.length > 0) {
      console.error('');
      console.error('A member an adopter can override names a type the package does not export.');
      console.error('Export it, inline the shape, or narrow the member to `private`:');
      console.error('');
      for (const finding of findings) {
         console.error(`✗ ${finding.package}  ${finding.member}  ${finding.slot} names \`${finding.type}\``);
         console.error(`    declared in ${finding.declaredIn}, unreachable from its entry points`);
         console.error(`    ${finding.file}:${finding.line}`);
      }
   }
   if (findings.length > 0 || missing.length > 0) {
      process.exit(1);
   }
   console.log(`\n✓ every type named by a subclass-visible member of ${packages.length} packages is importable from their entry points`);
}

main();
