/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript-api';

export function isGuidance(file: string): boolean {
   return file === 'AGENTS.md' || file === 'CLAUDE.md' || file.startsWith('.claude/rules/') || file.startsWith('.claude/skills/');
}

function guidanceProse(text: string): string {
   return text.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, '');
}

/** Names are an occurrence check, not a type checker; ordinary words are not identifiers. */
export function guidanceNames(text: string): string[] {
   return [...guidanceProse(text).matchAll(/`([^`\n]+)`/g)]
      .map(match => match[1].replace(/\(\)$/, ''))
      .filter(
         name =>
            /^npm run [\w:-]+(?:\s|$)/.test(name) ||
            name === '.nvmrc' ||
            /^(?:@[\w-]+\/[\w./-]+|[\w./-]+\.(?:md|[cm]?ts|[cm]?js|json)|(?:check|build|typecheck|test):[\w:-]+)$/.test(name) ||
            (/^[\w$]+(?:\.[\w$]+)*$/.test(name) && /[a-z][A-Z]|^[_$]|\.[\w$]+/.test(name))
      );
}

export function missingNames(
   text: string,
   files: readonly string[],
   tokens: ReadonlySet<string>,
   packages: ReadonlySet<string>,
   scripts: ReadonlySet<string>
): string[] {
   return guidanceNames(text).filter(name => {
      if (name.startsWith('npm run ')) return !scripts.has(name.split(/\s+/)[2]);
      if (name.startsWith('@')) return !packages.has(name);
      if (name.includes(':')) return !scripts.has(name);
      if (name === '.nvmrc' || /\.(md|[cm]?ts|[cm]?js|json)$/.test(name))
         return !files.some(file => file === name || file.endsWith('/' + name));
      return name.split('.').some(part => !tokens.has(part));
   });
}

/** A backlink must be a comment inside a runnable test, not a string or a file-level decoration. */
function testClaims(file: string, text: string): string[] {
   if (!text.includes('guidance-claim:')) return [];
   const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
   const bodies: ts.Node[] = [];
   const comments = new Map<number, ts.CommentRange>();
   function visit(node: ts.Node): void {
      for (const comment of [...(ts.getLeadingCommentRanges(text, node.pos) ?? []), ...(ts.getTrailingCommentRanges(text, node.end) ?? [])])
         comments.set(comment.pos, comment);
      if (ts.isCallExpression(node) && /^(?:describe|it|test)\.(?:skip|todo)(?:\.|$)/.test(node.expression.getText(source))) return;
      if (ts.isCallExpression(node) && /^(?:it|test)(?:\.each\([\s\S]*\))?$/.test(node.expression.getText(source))) {
         for (const argument of node.arguments)
            if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) bodies.push(argument.body);
      }
      ts.forEachChild(node, visit);
   }
   visit(source);
   const claims: string[] = [];
   for (const comment of comments.values()) {
      const match = /^\/\/ guidance-claim: ([a-z][a-z0-9-]*)\s*$/.exec(text.slice(comment.pos, comment.end));
      if (match && bodies.some(body => body.pos <= comment.pos && body.end >= comment.end)) claims.push(match[1]);
   }
   return claims;
}

export function claimErrors(pages: ReadonlyMap<string, string>, tests: ReadonlyMap<string, string>): string[] {
   const claims = new Map<string, { page: string; test: string }>();
   const errors: string[] = [];
   for (const [page, text] of pages) {
      for (const marker of guidanceProse(text).matchAll(/<!--\s*guidance-claim:([\s\S]*?)-->/g)) {
         const match = /^\s*([a-z][a-z0-9-]*)\s+test=(\S+)\s*$/.exec(marker[1]);
         if (!match) {
            errors.push(`${page}: malformed guidance-claim marker`);
            continue;
         }
         const [, id, test] = match;
         if (claims.has(id)) errors.push(`${page}: duplicate guidance claim ${id}`);
         claims.set(id, { page, test });
      }
   }
   const backlinks = new Map([...tests].map(([file, text]) => [file, testClaims(file, text)]));
   for (const [id, { page, test }] of claims) {
      if (backlinks.get(test)?.filter(backlink => backlink === id).length !== 1)
         errors.push(`${page}: ${id} needs exactly one backlink inside a runnable test in ${test}`);
   }
   for (const [file, ids] of backlinks)
      for (const id of ids) {
         if (claims.get(id)?.test !== file) errors.push(`${file}: orphan guidance claim ${id}`);
      }
   return errors;
}

export function checkGuidance(pages: ReadonlyMap<string, string>, files: readonly string[], root: string): string[] {
   const guidance = new Map([...pages].filter(([file]) => isGuidance(file)));
   const tokens = new Set<string>();
   const packages = new Set<string>();
   const scripts = new Set<string>();
   const tests = new Map<string, string>();
   // Guidance about retained AST edges depends on the pinned upstream runtime,
   // whose private fields need not appear in a framework import or re-export.
   const upstream = `${root}/node_modules/langium/lib`;
   for (const file of readdirSync(upstream, { recursive: true, encoding: 'utf8' })) {
      if (/\.[cm]?[jt]s$/.test(file))
         for (const token of readFileSync(`${upstream}/${file}`, 'utf8').matchAll(/[\w$]+/g)) tokens.add(token[0]);
   }
   for (const file of files) {
      if (/\.(?:test|spec)\.[cm]?tsx?$/.test(file)) tests.set(file, readFileSync(`${root}/${file}`, 'utf8'));
      if (file.endsWith('package.json')) {
         const manifest = JSON.parse(readFileSync(`${root}/${file}`, 'utf8'));
         for (const name of Object.keys(manifest.scripts ?? {})) scripts.add(name);
         for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }))
            packages.add(name);
         if (manifest.name) {
            packages.add(manifest.name);
            for (const key of Object.keys(manifest.exports ?? {})) if (key.startsWith('./')) packages.add(manifest.name + key.slice(1));
         }
      }
      if (/\.[cm]?[jt]sx?$/.test(file) && !file.includes('/test/') && !file.includes('/fixtures/')) {
         for (const token of readFileSync(`${root}/${file}`, 'utf8').matchAll(/[\w$]+/g)) tokens.add(token[0]);
      }
   }
   return [...guidance]
      .flatMap(([file, text]) => missingNames(text, files, tokens, packages, scripts).map(name => `${file}: missing guidance name ${name}`))
      .concat(claimErrors(guidance, tests));
}

export function guidanceSelfTests(): void {
   const page = '<!-- guidance-claim: one test=a.test.ts -->';
   const test = "it('works', () => {\n// guidance-claim: one\nexpect(true).toBe(true);\n});";
   const pages = new Map([['AGENTS.md', page]]);
   const tests = new Map([['a.test.ts', test]]);
   const assert = (condition: boolean, name: string): void => {
      if (!condition) throw new Error(`guidance self-test: ${name}`);
   };
   assert(claimErrors(pages, tests).length === 0, 'reciprocal claim');
   assert(claimErrors(new Map([['AGENTS.md', `\`\`\`html\n${page}\n\`\`\``]]), new Map()).length === 0, 'marker example is not a claim');
   assert(missingNames('`npm run gone`', [], new Set(), new Set(), new Set()).length === 1, 'removed npm command');
   assert(
      missingNames('`npm run build -- --flag`', [], new Set(), new Set(), new Set(['build'])).length === 0,
      'npm command with arguments'
   );
   assert(claimErrors(pages, new Map()).length > 0, 'removed test');
   assert(claimErrors(new Map(), tests).length > 0, 'removed claim');
   assert(claimErrors(pages, new Map([['a.test.ts', test.replace('it(', 'it.skip(')]])).length > 0, 'skipped test');
   assert(claimErrors(pages, new Map([['a.test.ts', `describe.skip('suite', () => { ${test} });`]])).length > 0, 'skipped suite');
   assert(
      claimErrors(pages, new Map([['a.test.ts', `const template = \`text \${value}\`;\n${test}`]])).length === 0,
      'template before backlink'
   );
   assert(claimErrors(pages, new Map([['a.test.ts', '// guidance-claim: one']])).length > 0, 'file-level comment');
   assert(claimErrors(pages, new Map([['a.test.ts', test + test]])).length > 0, 'duplicate backlink');
   assert(claimErrors(pages, new Map([['b.test.ts', test]])).length === 2, 'moved test');
   assert(
      claimErrors(pages, new Map([['a.test.ts', "it('works', () => { const text = '// guidance-claim: one'; });"]])).length > 0,
      'string is not a backlink'
   );
   assert(claimErrors(new Map([['AGENTS.md', page + page]]), tests).length > 0, 'duplicate claim');
   assert(claimErrors(new Map([['AGENTS.md', '<!-- guidance-claim: broken -->']]), tests).length > 0, 'malformed claim');
   assert(
      guidanceNames('`on` `src` `SingleProjectManager` `a.ts` `check:docs` `@hydranium/core/node`').length === 4,
      'name classification'
   );
   assert(guidanceNames('---\nname: `MissingType`\n---\n```ts\n`MissingType`\n```\n`on`').length === 0, 'front matter and fenced examples');
   assert(
      missingNames('`Gone.member` `gone.ts` `check:gone` `@gone/pkg`', [], new Set(['Gone']), new Set(), new Set()).length === 4,
      'removed names'
   );
   assert(
      missingNames(
         '`Some.member` `a.ts` `check:docs` `@scope/pkg`',
         ['src/a.ts'],
         new Set(['Some', 'member']),
         new Set(['@scope/pkg']),
         new Set(['check:docs'])
      ).length === 0,
      'existing names'
   );
}
