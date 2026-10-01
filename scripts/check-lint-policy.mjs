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
 * Exercise every lint policy and its exceptions with the tool that enforces it: Oxlint,
 * ast-grep or the phantom-dependency check. Each canary is planted at a real path, so a
 * scope glob that stops matching turns it red.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = `__lint-policy-${process.pid}`;
const nsImport = (name, module) => `import * as ${name} from '${module}'; void ${name};\n`;
const toast =
   "const owner = { messageService: { info(value: string | number) { return value; } } }; owner.messageService.info('Hello world');\n";
const PHANTOM = 'phantom-dependency';
const cases = [
   {
      name: 'unused disable directive',
      dir: 'packages/core/src',
      source: '// eslint-disable-next-line no-debugger\nexport const value = 1;\n',
      message: 'Unused'
   },
   {
      name: 'duplicate export',
      dir: 'packages/core/src',
      source: 'const a = 1; const b = 2; export { a as duplicate, b as duplicate };\n',
      rule: 'import(export)'
   },
   {
      name: 'duplicate import',
      dir: 'packages/core/src',
      source:
         "import { tick } from '@hydranium/protocol/testing';\nimport { waitFor } from '@hydranium/protocol/testing';\nexport const helpers = [tick, waitFor];\n",
      rule: 'import(no-duplicates)'
   },
   {
      name: 'unsafe optional chaining',
      dir: 'packages/core/src',
      source: 'export const read = (value?: { name: string }) => (value?.name as string).length;\n',
      rule: 'eslint(no-unsafe-optional-chaining)'
   },
   { name: 'undeclared source dependency', tool: 'deps', dir: 'packages/core/src', source: nsImport('tool', 'oxlint'), rule: PHANTOM },
   {
      name: 'undeclared import-equals dependency',
      tool: 'deps',
      dir: 'packages/core/src',
      source: "import tool = require('oxlint');\nexport const value = tool;\n",
      rule: PHANTOM
   },
   { name: 'root test tooling is allowed', tool: 'deps', dir: 'packages/core/test', source: nsImport('tool', 'oxlint') },
   { name: 'host-provided module is allowed', tool: 'deps', dir: 'examples/order-flow/vscode/src', source: nsImport('vscode', 'vscode') },
   { name: 'neutral Node import', dir: 'packages/core/src', source: nsImport('fs', 'node:fs'), rule: 'eslint(no-restricted-imports)' },
   {
      name: 'neutral Node subpath import',
      dir: 'packages/core/src',
      source: nsImport('fsPromises', 'node:fs/promises'),
      rule: 'eslint(no-restricted-imports)'
   },
   { name: 'Node tier is exempt', dir: 'packages/core/src/node', source: nsImport('fs', 'node:fs') },
   {
      name: 'direct Langium import',
      dir: 'packages/core/src',
      source: "import type { AstNode } from 'langium'; export type Node = AstNode;\n",
      rule: 'eslint(no-restricted-imports)'
   },
   { name: 'Langium chokepoint is exempt', dir: 'packages/langium/src', source: nsImport('langium', 'langium') },
   {
      name: 'neutral LSP value import',
      dir: 'packages/core/src',
      source: nsImport('lsp', '@hydranium/langium/lsp'),
      rule: 'eslint(no-restricted-imports)'
   },
   {
      name: 'neutral LSP type import is allowed',
      dir: 'packages/core/src',
      source: "import type { Range } from '@hydranium/langium/lsp'; export type PositionRange = Range;\n"
   },
   {
      name: 'neutral host type import',
      dir: 'packages/core/src',
      source: "import type { MessageService } from '@theia/core'; export type Service = MessageService;\n",
      rule: 'eslint(no-restricted-imports)'
   },
   {
      name: 'host subpath import in a neutral test tree',
      dir: 'packages/data-server/test',
      source: nsImport('inversify', '@theia/core/shared/inversify'),
      rule: 'eslint(no-restricted-imports)'
   },
   {
      name: 'host import in a neutral Node tier',
      dir: 'packages/glsp-server/src/node',
      source: nsImport('theia', '@theia/core'),
      rule: 'eslint(no-restricted-imports)'
   },
   { name: 'vscode protocol library is allowed', dir: 'packages/core/src', source: nsImport('rpc', 'vscode-jsonrpc') },
   {
      name: 'unlocalized toast',
      tool: 'ast-grep',
      dir: 'packages/client-theia/src',
      source: toast,
      rule: 'unlocalized-message-service-text'
   },
   {
      name: 'localized toast is allowed',
      tool: 'ast-grep',
      dir: 'packages/client-theia/src',
      source: toast
         .replace("'Hello world'", "nls.localize('hydranium/canary/info', 'Hello world')")
         .replace('const owner', 'const nls = { localize(_key: string, text: string) { return text; } }; const owner')
   },
   {
      name: 'numeric toast option is allowed',
      tool: 'ast-grep',
      dir: 'packages/client-theia/src',
      source: toast.replace("'Hello world'", '5000')
   },
   { name: 'backend localization is exempt', tool: 'ast-grep', dir: 'packages/client-theia/src/node', source: toast },
   {
      name: 'unlocalized command label',
      tool: 'ast-grep',
      dir: 'packages/client-theia/src',
      source: "export const command = { label: 'Hello world' };\n",
      rule: 'unlocalized-command-label'
   },
   {
      name: 'local fixture builder',
      tool: 'ast-grep',
      dir: 'packages/core/test',
      source: 'export function makeNoopLogger(): void {}\n',
      rule: 'test-fixture-builder-function'
   },
   {
      name: 'fixture builder name outside tests is allowed',
      tool: 'ast-grep',
      dir: 'packages/core/src',
      source: 'export function makeNoopLogger(): void {}\n'
   },
   { name: 'neutral global', dir: 'packages/core/src', source: 'export const pid = process.pid;\n', rule: 'eslint(no-restricted-globals)' },
   { name: 'Node testing globals are exempt', dir: 'packages/core/src/testing/node', source: 'export const pid = process.pid;\n' }
];
const files = [];
const createdDirs = [];
let child;
function cleanup() {
   for (const file of files) {
      rmSync(join(root, file), { force: true });
   }
   for (const dir of [...createdDirs].reverse()) {
      // Remove only previously absent directories if they are still empty.
      try {
         rmdirSync(dir);
      } catch {
         /* A concurrent writer may have populated it. */
      }
   }
}
const interrupt = signal => {
   child?.kill(signal);
   process.exit(signal === 'SIGINT' ? 130 : 143);
};
const onSigint = () => interrupt('SIGINT');
const onSigterm = () => interrupt('SIGTERM');
process.once('exit', cleanup);
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);

// An asynchronous child lets the signal handlers run while a tool is working.
const run = (command, args) =>
   new Promise(resolveRun => {
      child = execFile(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
         resolveRun({ error, stdout, stderr })
      );
   });

/** Diagnostics per planted file, as `{ code, message }`, from each enforcing tool. */
async function oxlintDiagnostics() {
   // Call the JS entry point through Node for Windows without a shell wrapper.
   const result = await run(process.execPath, [
      join(root, 'node_modules/oxlint/bin/oxlint'),
      '--config',
      'oxlint.config.cjs',
      '--format',
      'json',
      ...files
   ]);
   const start = result.stdout?.indexOf('{ "diagnostics"') ?? -1;
   if (start < 0) {
      throw result.error ?? new Error(`Oxlint returned no diagnostic report: ${result.stdout}\n${result.stderr}`);
   }
   const report = JSON.parse(result.stdout.slice(start));
   if (report.number_of_files !== files.length) {
      throw new Error(`Oxlint checked ${report.number_of_files} files, expected ${files.length}.`);
   }
   return file =>
      report.diagnostics.filter(item => item.filename.replaceAll('\\', '/') === file).map(({ code, message }) => ({ code, message }));
}

async function astGrepDiagnostics() {
   const binary = join(root, 'node_modules/@ast-grep/cli', process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep');
   const result = await run(binary, ['scan', '--config', 'sgconfig.yml', '--json=compact', ...files]);
   if (!result.stdout?.startsWith('[')) {
      throw result.error ?? new Error(`ast-grep returned no JSON report: ${result.stdout}\n${result.stderr}`);
   }
   const matches = JSON.parse(result.stdout);
   return file =>
      matches.filter(item => item.file.replaceAll('\\', '/') === file).map(({ ruleId, message }) => ({ code: ruleId, message }));
}

async function phantomDiagnostics() {
   const result = await run(process.execPath, [join(root, 'scripts/check-phantom-dependencies.mjs'), ...files]);
   const lines = `${result.stdout}\n${result.stderr}`.split('\n');
   if (!lines.some(line => line.startsWith('✓') || line.startsWith('✗'))) {
      throw result.error ?? new Error(`The phantom-dependency check printed no verdict: ${result.stdout}\n${result.stderr}`);
   }
   return file => lines.filter(line => line.startsWith(`${file}:`)).map(message => ({ code: PHANTOM, message }));
}

try {
   for (const [index, test] of cases.entries()) {
      const dir = join(root, test.dir);
      if (!existsSync(dir)) {
         mkdirSync(dir, { recursive: true });
         createdDirs.push(dir);
      }
      const file = `${test.dir}/${stamp}-${index}.${test.ext ?? 'ts'}`;
      files.push(file);
      writeFileSync(join(root, file), test.source);
   }
   const tools = { oxlint: await oxlintDiagnostics(), 'ast-grep': await astGrepDiagnostics(), deps: await phantomDiagnostics() };
   const problems = [];
   for (const [index, test] of cases.entries()) {
      const diagnostics = tools[test.tool ?? 'oxlint'](files[index]);
      const found = test.rule
         ? diagnostics.some(item => item.code === test.rule)
         : test.message
           ? diagnostics.some(item => item.message.includes(test.message))
           : diagnostics.length === 0;
      if (!found) {
         problems.push(`${test.name}: expected ${test.rule ?? test.message ?? 'no diagnostics'}, got ${JSON.stringify(diagnostics)}`);
      }
   }
   if (problems.length) {
      throw new Error(problems.join('\n'));
   }
   console.log(`✓ ${cases.length} lint policy canaries reject violations and accept their exceptions`);
} finally {
   cleanup();
   process.removeListener('exit', cleanup);
   process.removeListener('SIGINT', onSigint);
   process.removeListener('SIGTERM', onSigterm);
}
