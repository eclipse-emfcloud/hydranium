/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractAstReflection, type AstReflection } from '@hydranium/langium';

/** The troubleshooting entry listing the causes; its heading is the anchor. */
const CAUSES_URL =
   'https://github.com/eclipse-emfcloud/hydranium/blob/main/docs/adopting/troubleshooting.md' +
   '#startup-rejects-the-ast-reflection-or-a-cancelled-validation-reports-symboloperationcancelled';

/**
 * Fail fast when `reflection` extends `AbstractAstReflection` from a second
 * copy of `langium`, which the files `langium-cli` generates run on: a second
 * install, or one install a bundler or test runner loads twice.
 *
 * A reflection whose prototype chain misses this copy's base is taken to come
 * from another copy when it carries the `subtypes` and `allSubtypes` fields that
 * base creates, which `AstReflection` does not declare. Fields rather than the
 * class name, because bundlers and minifiers rename classes; a hand-written
 * reflection passes unless it declares both fields itself.
 */
export function assertSingleLangiumCopy(
   reflection: AstReflection,
   subject: () => string = () => `the shared AstReflection (${reflection.constructor?.name ?? 'no constructor'})`
): void {
   if (reflection instanceof AbstractAstReflection) {
      return;
   }
   if (Object.hasOwn(reflection, 'subtypes') && Object.hasOwn(reflection, 'allSubtypes')) {
      throw new Error(
         `[hydranium] ${subject()} extends \`AbstractAstReflection\` from another instance of \`langium\` than ` +
            'the one `@hydranium/langium` loads, a second physical copy or one install loaded twice, so the generated ' +
            'code runs on one and the framework on the other. Values Langium compares by identity, such as its ' +
            'cancellation signal, are not recognised across the two. `npm explain langium` lists each installed copy ' +
            `and what requires it. The causes and their remedies: ${CAUSES_URL}`
      );
   }
}
