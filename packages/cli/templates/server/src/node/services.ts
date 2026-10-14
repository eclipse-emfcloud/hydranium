// Zero-arg service factory for the headless `hydranium-cli` tooling: the
// `reflect` / `lint-grammar` / `validate` subcommands import this via
// `--services ./lib/node/services.js`. The head wires its own filesystem here.
//
// Behind the package's `./node` entry rather than its root because it reads
// the real filesystem: the root stays loadable in a browser worker, which has
// no `node:fs`.
//
// The contract is language-count-agnostic — a second grammar needs no edit here.

import { NodeFileSystem } from '@hydranium/core/node';
import { create__NAME__Services } from '../language-server/__PROJECT_ID__-module.js';

export function createServices(): ReturnType<typeof create__NAME__Services> {
   return create__NAME__Services({ ...NodeFileSystem });
}
