/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The commit the served page was built from, read from the document.
 *
 * Taken from a `<meta>` rather than a bundle `define`, because esbuild output
 * is cached against declared input FILES and a hash is not one: a cache hit
 * would stamp the bundle with the previous commit, and a field whose only job
 * is to be trusted cannot have a silent path to being wrong.
 */

import { requireElement } from './dom.js';

const REPOSITORY_URL = 'https://github.com/eclipse-emfcloud/hydranium';

/** The full value stays on the `title` and the link. */
const ABBREVIATED_LENGTH = 7;

/**
 * Reaches only the document and `dom.ts`, so it is safe before anything else
 * has initialized — the state in which the build is most worth knowing.
 */
export function applyBuildStamp(): void {
   const commit = document.querySelector<HTMLMetaElement>('meta[name="build-commit"]')?.content.trim();
   // Empty on a checkout, which is not a failure: `requireElement` throws, so
   // it is reached only once there is something to show.
   if (!commit) {
      return;
   }
   const stamp = requireElement('build-commit');
   // The nested span, not the anchor: writing `textContent` on the anchor
   // would take the icon with it.
   requireElement('build-commit-hash').textContent = commit.slice(0, ABBREVIATED_LENGTH);
   stamp.title = commit;
   if (stamp instanceof HTMLAnchorElement) {
      stamp.href = `${REPOSITORY_URL}/commit/${commit}`;
   }
   stamp.hidden = false;
}
