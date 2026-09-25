/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The data head over a worker port under `vscode-jsonrpc/node`'s runtime, the
 * one a Node host running a head in a `worker_threads` worker has. A file of
 * its own because a runtime is installed per module graph, by whichever entry
 * is evaluated last.
 */

import { describeWorkerPortHead } from './worker-port-head.js';
// LAST, so no other entry can win. The `beforeAll` checks that this one did.
import 'vscode-jsonrpc/node';

describeWorkerPortHead('node');
