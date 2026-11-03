/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHarnessArgs } from '../src/commands/harness-args.js';

let root: string;
beforeEach(() => {
   root = mkdtempSync(join(tmpdir(), 'hydranium-services-'));
});
afterEach(() => {
   vi.restoreAllMocks();
   rmSync(root, { recursive: true, force: true });
});
const fail = (message: string): never => {
   throw new Error(message);
};
function parse(args: string[] = []) {
   return parseHarnessArgs(args, 'reflect', [], [], { requireWorkspace: false, onError: fail });
}

describe('parseHarnessArgs project services', () => {
   it('finds the nearest manifest from a nested directory and anchors its services path there', () => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ hydranium: { services: './server/lib/services.js' } }));
      mkdirSync(join(root, 'server', 'lib'), { recursive: true });
      writeFileSync(join(root, 'server', 'lib', 'services.js'), '');
      const nested = join(root, 'source', 'nested');
      mkdirSync(nested, { recursive: true });
      vi.spyOn(process, 'cwd').mockReturnValue(nested);
      expect(parse().servicesModule).toBe(join(root, 'server', 'lib', 'services.js'));
   });

   it('keeps an explicit flag authoritative even when project configuration is invalid', () => {
      writeFileSync(join(root, 'package.json'), '{ invalid json');
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      expect(parse(['--services', './other.js']).servicesModule).toBe('./other.js');
   });

   it("does not inherit a different package's services across a package boundary", () => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ hydranium: { services: './parent.js' } }));
      const member = join(root, 'member');
      mkdirSync(member);
      writeFileSync(join(member, 'package.json'), '{}');
      vi.spyOn(process, 'cwd').mockReturnValue(member);
      expect(() => parse()).toThrow('hydranium.services');
   });

   it.each([42, '', null])('rejects an invalid services value %s with the manifest location', value => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ hydranium: { services: value } }));
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      expect(() => parse()).toThrow(join(root, 'package.json'));
      expect(() => parse()).toThrow('hydranium.services');
   });

   it('names the configured setting and manifest when its file has not been built', () => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ hydranium: { services: './missing.js' } }));
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      expect(() => parse()).toThrow('hydranium.services');
      expect(() => parse()).toThrow(join(root, 'package.json'));
      expect(() => parse()).toThrow('Build the project');
   });

   it('reports malformed configuration rather than silently treating it as absent', () => {
      writeFileSync(join(root, 'package.json'), '{ invalid json');
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      expect(() => parse()).toThrow(join(root, 'package.json'));
   });
});
