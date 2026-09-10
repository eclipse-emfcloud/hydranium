/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { collectMessages } from '@hydranium/protocol';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as messages from '../src/messages/index.js';

/**
 * The ONLY enforcement of the `hydranium/<unscoped-package>/<name>` convention.
 * Lint cannot see a key's shape, and declaring messages per-package means
 * nothing else checks uniqueness or the prefix — a copy-pasted declaration could
 * otherwise claim another package's namespace and no gate would notice.
 */
describe('the glsp-server message barrel', () => {
   const declarations = collectMessages(messages);
   const codes = declarations.map(declaration => declaration.code);

   it('enumerates every declaration the package raises', () => {
      expect(codes.length).toBeGreaterThan(0);
   });

   it('prefixes every code with this package', () => {
      expect(codes.filter(code => !code.startsWith('hydranium/glsp-server/'))).toEqual([]);
   });

   it('has no duplicate code', () => {
      expect(new Set(codes).size).toBe(codes.length);
   });

   it('has no code that is a prefix of another', () => {
      // Hard-required rather than insurance: a host catalogue is nested JSON and
      // errors outright when one key is a prefix of another.
      const prefixed = codes.filter(code => codes.some(other => other !== code && other.startsWith(code)));
      expect(prefixed).toEqual([]);
   });

   it('gives every declaration a non-empty English default', () => {
      expect(declarations.filter(declaration => declaration.text.trim() === '')).toEqual([]);
   });

   /**
    * The raise-site rule, which this head alone has to keep by hand.
    *
    * Every other head renders at a chokepoint — one diagnostics pass, one
    * `onRequest` registration — so a new message there is rendered by the
    * binding that already exists. GLSP's action protocol carries no identity
    * slot anywhere, so its messages are rendered AT the throw, and a third
    * declaration added later would ship English with nothing to notice. That
    * asymmetry is stated in the framework's own record; this is the check that
    * makes it hold.
    *
    * A SOURCE SCAN because the defect is a call that was never written: no
    * runtime observation can distinguish "rendered, no catalogue entry" from
    * "never rendered", both being the English. The theia catalogue suite scans
    * source for the same reason.
    */
   it('reaches no declaration through `.format()` in the package source', () => {
      const sourceRoot = path.join(__dirname, '..', 'src');
      const files = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
         .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
         .map(entry => path.join(entry.parentPath, entry.name));
      // A glob that stopped matching would make the scan pass against an empty
      // string, which is the failure a recursive read invites.
      expect(files.length).toBeGreaterThan(5);
      const source = files.map(file => readFileSync(file, 'utf-8')).join('\n');

      // By DECLARATION NAME, taken from the barrel's own exports, so a new
      // message is covered the moment it is exported rather than when someone
      // remembers to add it here.
      const names = Object.entries(messages)
         .filter(([, value]) => declarations.includes(value as (typeof declarations)[number]))
         .map(([name]) => name);
      expect(names.length).toBe(declarations.length);

      expect(names.filter(name => source.includes(`${name}.format(`))).toEqual([]);
   });
});
