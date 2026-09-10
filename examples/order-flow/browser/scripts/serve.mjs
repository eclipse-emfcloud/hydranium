/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// A static server for the page, hand-rolled rather than taken from a dependency.
//
// `new Worker(...)` is same-origin only, so the page cannot be opened over
// `file://` — some server has to exist. Adding one from npm to serve four files
// would put a transitive tree into an example whose whole subject is what its
// bundle contains.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 3002);

// `.css` earns its entry: a stylesheet served as `application/octet-stream` is
// DROPPED by the browser in standards mode with only a console warning, so the
// diagram renders unstyled and the page looks like a model defect. `.svg` earns
// its own for the same reason one layer over: an icon served as a byte stream is
// refused, and the tab falls back to the default globe with nothing said.
const CONTENT_TYPES = {
   '.css': 'text/css; charset=utf-8',
   '.html': 'text/html; charset=utf-8',
   '.js': 'text/javascript; charset=utf-8',
   '.map': 'application/json; charset=utf-8',
   '.svg': 'image/svg+xml'
};

createServer((request, response) => {
   const requestPath = new URL(request.url ?? '/', `http://localhost:${port}`).pathname;
   // `normalize` collapses `..` before the prefix check, so a traversal attempt
   // resolves outside the root and is rejected rather than served.
   const target = join(packageRoot, normalize(requestPath === '/' ? '/index.html' : requestPath));
   if (!target.startsWith(packageRoot) || !existsSync(target) || !statSync(target).isFile()) {
      // Logged because a missing WORKER script is otherwise invisible: the
      // browser reports it as an `ErrorEvent` with no message, no filename and
      // no line, so the page cannot tell a 404 from a crash and this line is the
      // only place the difference is recorded.
      console.log(`404 ${requestPath}`);
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`Not found: ${requestPath}`);
      return;
   }
   response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream' });
   createReadStream(target).pipe(response);
}).listen(port, () => {
   console.log(`Order Flow browser app: http://localhost:${port}/`);
   console.log('Oracle: npx hydranium-cli validate --services examples/order-flow/server/lib/services.js examples/order-flow/workspace');
});
