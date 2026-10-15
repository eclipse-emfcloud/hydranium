// `npm start`: the Theia backend on `THEIA_PORT`, 3000 when it is unset, on the
// folder given as the argument, `../workspace` when there is none. A script
// rather than `--port=${THEIA_PORT:-3000}` in package.json: only a POSIX shell
// expands that, and npm also runs scripts under cmd.exe.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths from this file, not the working directory, which a direct `node` run can set anywhere.
const here = path.dirname(fileURLToPath(import.meta.url));
const link = path.join(here, 'plugins', '__PROJECT_ID__-vscode-servers');

// The servers extension, sideloaded from plugins/ beside any other plugin there.
// Linked here rather than in the build, which a build cache can replay without
// it; replaced every time, since a dangling link left by a moved extension
// fails `symlinkSync`.
fs.mkdirSync(path.dirname(link), { recursive: true });
const existing = fs.lstatSync(link, { throwIfNoEntry: false });
// A link, a junction included, is unlinked, never handed to a recursive remove
// that might reach `../vscode-servers` through it.
if (existing?.isSymbolicLink()) {
   fs.unlinkSync(link);
} else {
   fs.rmSync(link, { recursive: true, force: true });
}
fs.symlinkSync(path.join(here, '../vscode-servers'), link, 'junction');

const port = Number(process.env.THEIA_PORT || 3000);
const workspace = path.resolve(process.argv[2] ?? path.join(here, '../workspace'));
// The CLI run by this Node, with no shell: the workspace path reaches Theia as it is.
// `local-dir:` relative to `cwd`, since Theia reads an absolute path as a URI.
const cli = createRequire(import.meta.url).resolve('@theia/cli/bin/theia.js');
const theia = spawn(process.execPath, [cli, 'start', '--plugins=local-dir:./plugins', `--port=${port}`, workspace], {
   cwd: here,
   stdio: 'inherit'
});
for (const signal of ['SIGINT', 'SIGTERM']) {
   process.on(signal, () => theia.kill(signal));
}
theia.on('exit', (code, signal) => {
   if (signal === null) {
      process.exit(code ?? 1);
   }
   // Ended by a signal, so end by it too: Ctrl+C is a stop, not a failure.
   process.removeAllListeners(signal);
   process.kill(process.pid, signal);
});
