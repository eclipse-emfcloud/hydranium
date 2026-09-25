/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The data head over a worker port under `vscode-jsonrpc/browser`'s runtime,
 * the one a browser host runs. A file of its own because a runtime is
 * installed per module graph, by whichever entry is evaluated last.
 */

import { describeWorkerPortHead } from './worker-port-head.js';
// LAST: the server's imports reach `vscode-languageserver`'s Node entry, which
// installs the Node runtime. The `beforeAll` checks that this one won.
import 'vscode-jsonrpc/browser';

describeWorkerPortHead('browser');
