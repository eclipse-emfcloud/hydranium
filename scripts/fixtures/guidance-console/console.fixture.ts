/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { expect, it } from 'vitest';

it('prints from a passing test', () => {
   console.log('GUIDANCE_PASS_CONSOLE');
   process.stderr.write('GUIDANCE_PASS_STDERR\n');
   expect(true).toBe(true);
});

it('prints from a failing test', () => {
   console.log('GUIDANCE_FAIL_CONSOLE');
   process.stderr.write('GUIDANCE_FAIL_STDERR\n');
   expect(true).toBe(false);
});
