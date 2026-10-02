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
 * Every package a workspace imports must be declared in that workspace's manifest.
 *
 * npm hoists the whole tree into one `node_modules`, so an undeclared import
 * resolves here and fails for a consumer installing the published package.
 * `src` is what ships: it may use `dependencies` and `peerDependencies` only,
 * since `peerDependencies` is how the `@hydranium/*` edges are declared. A
 * `test` tree may also use devDependencies of its package and of the repo root,
 * where the shared test tooling is declared; without this check a Playwright
 * tier outside `check` would fail only when someone runs it.
 *
 * Type-only imports count, because a type a consumer cannot install breaks their
 * compile. A specifier that resolves to no installed package is skipped, as
 * TypeScript already reports it. A package whose types come from `@types/<name>`
 * alone, such as the host-provided `vscode` module, is declared by that package.
 *
 * Usage: `check-phantom-dependencies.mjs [file...]`. Without files it checks
 * every tracked source file of every workspace.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = file => JSON.parse(readFileSync(file, 'utf-8'));
const rootManifest = readJson(join(root, 'package.json'));

/** Workspaces whose `src` runs inside a host that provides a devDependency-typed module at runtime. */
const HOST_PROVIDED = new Set(['examples/order-flow/vscode', 'examples/order-flow/vscode-servers']);
const GENERATED = /\/(generated|generated-hydranium)\//;
const SOURCE_EXTENSIONS = { src: /\.tsx?$/, test: /\.(tsx?|mts)$/ };

function workspaceDirs() {
   return (rootManifest.workspaces ?? []).flatMap(entry => {
      if (!entry.endsWith('/*')) {
         return existsSync(join(root, entry, 'package.json')) ? [entry] : [];
      }
      const base = entry.slice(0, -2);
      return execFileSync('git', ['-C', root, 'ls-files', `${base}/*/package.json`], { encoding: 'utf-8' })
         .split('\n')
         .filter(file => file.split('/').length === base.split('/').length + 2)
         .map(file => dirname(file));
   });
}

const workspaces = workspaceDirs().sort((left, right) => right.length - left.length);

/** The workspace and tier (`src` or `test`) a repo-relative file belongs to, or `undefined`. */
function classify(file) {
   const workspace = workspaces.find(dir => file.startsWith(`${dir}/`));
   const tier = workspace && file.slice(workspace.length + 1).split('/')[0];
   if (
      !workspace ||
      !(tier in SOURCE_EXTENSIONS) ||
      !SOURCE_EXTENSIONS[tier].test(file) ||
      file.endsWith('.d.ts') ||
      GENERATED.test(file)
   ) {
      return undefined;
   }
   return { workspace, tier };
}

const declaredCache = new Map();
/** Declaration status per package name: the allowed fields, plus the fields a denial should name. */
function declarations(workspace, tier) {
   const key = `${workspace}:${tier}`;
   if (!declaredCache.has(key)) {
      const manifests =
         tier === 'test'
            ? [readJson(join(root, workspace, 'package.json')), rootManifest]
            : [readJson(join(root, workspace, 'package.json'))];
      const allowDev = tier === 'test' || HOST_PROVIDED.has(workspace);
      const allowed = new Set(manifests.map(manifest => manifest.name));
      const denied = new Map();
      for (const manifest of manifests) {
         for (const field of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies']) {
            for (const name of Object.keys(manifest[field] ?? {})) {
               if (field === 'dependencies' || field === 'peerDependencies' || (field === 'devDependencies' && allowDev)) {
                  allowed.add(name);
               } else if (!denied.has(name)) {
                  denied.set(name, field);
               }
            }
         }
      }
      declaredCache.set(key, { allowed, denied });
   }
   return declaredCache.get(key);
}

const packageName = specifier =>
   specifier
      .split('/')
      .slice(0, specifier.startsWith('@') ? 2 : 1)
      .join('/');
const typesPackageName = name => `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`;

/** Whether `name` is installed where Node would look for it from `file`. */
function installed(file, name) {
   for (let dir = dirname(join(root, file)); ; dir = dirname(dir)) {
      if (existsSync(join(dir, 'node_modules', name, 'package.json'))) {
         return true;
      }
      if (dir === root || dir === dirname(dir)) {
         return false;
      }
   }
}

/** Every module specifier in `source`, with the offset it starts at. */
function specifiers(file, source) {
   const { module, program } = parseSync(file, source);
   const found = [
      ...module.staticImports.map(entry => entry.moduleRequest),
      ...module.staticExports.flatMap(entry => entry.entries.map(item => item.moduleRequest).filter(Boolean)),
      ...module.dynamicImports.map(entry => {
         const text = source.slice(entry.moduleRequest.start, entry.moduleRequest.end);
         return /^(['"])[^'"]*\1$/.test(text) ? { value: text.slice(1, -1), start: entry.moduleRequest.start } : undefined;
      })
   ].filter(Boolean);
   // `import x = require('…')` and `require('…')` are absent from the module record.
   const visit = node => {
      if (Array.isArray(node)) {
         node.forEach(visit);
         return;
      }
      if (!node || typeof node !== 'object') {
         return;
      }
      if (node.type === 'TSExternalModuleReference' && typeof node.expression?.value === 'string') {
         found.push({ value: node.expression.value, start: node.expression.start });
      } else if (
         node.type === 'CallExpression' &&
         node.callee?.type === 'Identifier' &&
         node.callee.name === 'require' &&
         node.arguments?.[0]?.type === 'Literal' &&
         typeof node.arguments[0].value === 'string'
      ) {
         found.push({ value: node.arguments[0].value, start: node.arguments[0].start });
      }
      for (const [key, value] of Object.entries(node)) {
         if (key !== 'parent' && value && typeof value === 'object') {
            visit(value);
         }
      }
   };
   visit(program);
   return found;
}

/** Problems in one repo-relative file, as `file:line: message` strings. */
export function checkFile(file) {
   const placement = classify(file);
   if (!placement) {
      return [];
   }
   const { allowed, denied } = declarations(placement.workspace, placement.tier);
   const source = readFileSync(join(root, file), 'utf-8');
   const problems = [];
   for (const { value, start } of specifiers(file, source)) {
      if (value.startsWith('.') || value.startsWith('/') || value.startsWith('#') || isBuiltin(value)) {
         continue;
      }
      const name = packageName(value);
      if (allowed.has(name)) {
         continue;
      }
      const types = typesPackageName(name);
      if (!installed(file, name)) {
         if (!installed(file, types) || allowed.has(types)) {
            continue;
         }
      }
      const line = source.slice(0, start).split('\n').length;
      const field = denied.get(name);
      problems.push(
         `${file}:${line}: '${name}' ${field ? `is declared only in ${field}, which ${placement.tier} may not use` : 'is not declared'} in ${placement.workspace}/package.json${placement.tier === 'test' ? ' or the root package.json' : ''}.`
      );
   }
   return problems;
}

function trackedFiles() {
   return execFileSync('git', ['-C', root, 'ls-files', ...workspaces.flatMap(dir => [`${dir}/src`, `${dir}/test`])], { encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
   const requested = process.argv.slice(2).map(file => relative(root, resolve(file)).replaceAll('\\', '/'));
   const files = requested.length ? requested : trackedFiles();
   const problems = files.flatMap(checkFile);
   if (problems.length) {
      console.error(problems.join('\n'));
      console.error(`\n✗ ${problems.length} undeclared import(s). Declare each package in the manifest named, or remove the import.`);
      process.exit(1);
   }
   console.log(`✓ every import in ${files.length} source files of ${workspaces.length} workspaces is declared`);
}
