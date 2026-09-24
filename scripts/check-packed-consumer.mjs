/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Exercise the framework packages from outside the workspace graph, installed
// the way a consumer installs them, then compile and smoke that consumer. Run
// after build. By default the consumer gets the candidate tarballs packed from
// this tree; `--published-prerelease` gives it the published prerelease instead,
// and `--upgrade-from-published` installs the published prerelease first and
// then upgrades the same consumer to the candidates.
//
// The published baseline is the `latest` dist-tag, resolved per run, because a
// release lands with nearly every merge: a version pinned here is stale within
// hours, and nothing would bump it. For the upgrade, `HYDRANIUM_UPGRADE_FROM`
// overrides it, so a failure can be re-run against the version it printed.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const negativeMissingPackageFile = process.argv.includes('--negative-missing-package-file');
const publishedPrerelease = process.argv.includes('--published-prerelease');
const upgradeFromPublished = process.argv.includes('--upgrade-from-published');

if ([negativeMissingPackageFile, publishedPrerelease, upgradeFromPublished].filter(Boolean).length > 1) {
   throw new Error('--negative-missing-package-file, --published-prerelease and --upgrade-from-published are mutually exclusive');
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const example = join(root, 'examples/bookstore/server');
const scratch = mkdtempSync(join(tmpdir(), 'hydranium-packed-consumer-'));
const tarballs = join(scratch, 'tarballs');
const consumer = join(scratch, 'consumer');
const packageDirs = ['langium', 'protocol', 'core', 'data-server', 'glsp-server'];
const env = { ...process.env, npm_config_workspaces: 'false' };

/** Run a consumer step, naming the phase in the error so a failure says where it happened. */
function run(label, program, args, cwd) {
   const result = spawnSync(program, args, { cwd, env, stdio: 'inherit' });
   if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
   if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

function packageName(directory) {
   return JSON.parse(readFileSync(join(root, 'packages', directory, 'package.json'), 'utf8')).name;
}

function publishedBaseline(override) {
   const version =
      override || JSON.parse(execFileSync('npm', ['view', '@hydranium/core', 'dist-tags.latest', '--json'], { encoding: 'utf8' }));
   if (!version || !/-next\./.test(version)) {
      const source = override ? 'HYDRANIUM_UPGRADE_FROM' : 'dist-tag latest';
      throw new Error(`expected a published prerelease from ${source}, found ${version ?? 'nothing'}`);
   }
   return version;
}

/** Pack every framework package into `tarballs`, answering name → `file:` specifier. */
function packCandidates() {
   const candidates = new Map();
   for (const directory of packageDirs) {
      const output = execFileSync('npm', ['pack', '--json', '--pack-destination', tarballs], {
         cwd: join(root, 'packages', directory),
         encoding: 'utf8'
      });
      const filename = JSON.parse(output)[0]?.filename;
      if (!filename) throw new Error(`npm pack produced no tarball for ${directory}`);
      candidates.set(packageName(directory), `file:${join(tarballs, filename)}`);
   }
   return candidates;
}

/** Write the consumer project: the bookstore server's source and dependencies, with `packages` pinned. */
function writeConsumer(packages) {
   const sourcePackage = JSON.parse(readFileSync(join(example, 'package.json'), 'utf8'));
   const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
   const dependencies = { ...sourcePackage.dependencies, 'vscode-jsonrpc': '9.0.1' };
   for (const [name, dependencySpec] of packages) dependencies[name] = dependencySpec;
   writeFileSync(
      join(consumer, 'package.json'),
      `${JSON.stringify(
         {
            name: 'hydranium-packed-consumer-check',
            version: '0.0.0',
            private: true,
            type: 'module',
            engines: { node: '>=22.13' },
            dependencies,
            devDependencies: { '@types/node': '^22.0.0', 'patch-package': '^8.0.1', typescript: '^5.8.0' },
            scripts: { postinstall: 'patch-package' },
            overrides: rootPackage.overrides
         },
         null,
         2
      )}\n`
   );
   cpSync(join(example, 'src'), join(consumer, 'src'), { recursive: true });
   cpSync(join(root, 'scripts/fixtures/packed-consumer/smoke.mjs'), join(consumer, 'smoke.mjs'));
   mkdirSync(join(consumer, 'patches'));
   cpSync(join(root, 'patches/vscode-jsonrpc+9.0.1.patch'), join(consumer, 'patches/vscode-jsonrpc+9.0.1.patch'));
   const base = JSON.parse(readFileSync(join(root, 'tsconfig.base.json'), 'utf8'));
   writeFileSync(
      join(consumer, 'tsconfig.json'),
      `${JSON.stringify(
         {
            compilerOptions: {
               ...base.compilerOptions,
               composite: false,
               incremental: false,
               declaration: false,
               declarationMap: false,
               module: 'NodeNext',
               moduleResolution: 'NodeNext',
               rootDir: 'src',
               outDir: 'lib'
            },
            include: ['src']
         },
         null,
         2
      )}\n`
   );
   mkdirSync(join(consumer, 'workspace'));
   writeFileSync(join(consumer, 'workspace/catalogue.bookstore'), 'node Bookstore\nnode Fiction -> Bookstore\n');
}

/** Point the consumer's framework dependencies at `packages`, leaving the rest as written. */
function repointConsumer(packages) {
   const manifestPath = join(consumer, 'package.json');
   const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
   for (const [name, dependencySpec] of packages) manifest.dependencies[name] = dependencySpec;
   writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Assert each framework package is a real directory, named as expected, and
 * came from where its specifier says: a `file:` tarball, or exactly the
 * published version from the registry.
 */
function assertInstalledFrom(packages) {
   const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
   for (const [name, dependencySpec] of packages) {
      const installedDir = join(consumer, 'node_modules', name);
      const manifest = join(installedDir, 'package.json');
      const resolved = String(lock.packages?.[`node_modules/${name}`]?.resolved);
      const installed = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : undefined;
      if (!installed || lstatSync(installedDir).isSymbolicLink() || installed.name !== name) {
         throw new Error(`consumer package ${name} is missing or installed through a symlink`);
      }
      if (dependencySpec.startsWith('file:')) {
         if (!resolved.startsWith('file:')) throw new Error(`packed package ${name} was not installed from a tarball`);
      } else if (installed.version !== dependencySpec || resolved.startsWith('file:')) {
         throw new Error(`published package ${name} resolved to ${installed.version}, expected ${dependencySpec}`);
      }
   }
}

/** Assert the wire stack resolved to the pinned versions, and to one physical copy each. */
function assertSingleCopies() {
   for (const [name, version] of [
      ['langium', '4.3.1'],
      ['vscode-jsonrpc', '9.0.1'],
      ['vscode-languageserver-protocol', '3.18.2']
   ]) {
      const installed = JSON.parse(readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8'));
      if (installed.version !== version) throw new Error(`${name} resolved to ${installed.version}, expected ${version}`);
   }
   const physical = execFileSync('npm', ['ls', 'langium', 'vscode-jsonrpc', '--all', '--parseable'], {
      cwd: consumer,
      env,
      encoding: 'utf8'
   })
      .trim()
      .split('\n');
   for (const name of ['langium', 'vscode-jsonrpc']) {
      const copies = physical.filter(path => path.endsWith(`/node_modules/${name}`));
      if (copies.length !== 1) throw new Error(`expected one physical ${name} install, found ${copies.length}`);
   }
}

const install = ['install', '--strict-peer-deps', '--no-audit', '--no-fund'];

try {
   mkdirSync(tarballs);
   mkdirSync(consumer);
   const published =
      publishedPrerelease || upgradeFromPublished
         ? publishedBaseline(upgradeFromPublished ? process.env.HYDRANIUM_UPGRADE_FROM : undefined)
         : undefined;
   if (upgradeFromPublished) {
      process.stdout.write(`Upgrading from ${published} (set HYDRANIUM_UPGRADE_FROM to repeat this run).\n`);
   }
   const candidates = publishedPrerelease ? undefined : packCandidates();
   const first = new Map(packageDirs.map(directory => [packageName(directory), published ?? candidates.get(packageName(directory))]));

   writeConsumer(first);
   run(published ? `Prerelease resolution (${published})` : 'Candidate resolution', 'npm', install, consumer);
   if (negativeMissingPackageFile) {
      // Control mode: prove the package-file assertion is load-bearing by
      // removing a required installed manifest before validation. The command
      // is expected to fail with the package-installation error below.
      rmSync(join(consumer, 'node_modules', '@hydranium/core', 'package.json'));
   }
   assertInstalledFrom(first);

   if (upgradeFromPublished) {
      repointConsumer(candidates);
      run('Candidate migration to tarballs', 'npm', install, consumer);
      assertInstalledFrom(candidates);
   }

   assertSingleCopies();
   run('Consumer compile', 'npm', ['exec', '--', 'tsc', '-p', 'tsconfig.json'], consumer);
   run('Consumer LSP and data smoke', 'node', ['smoke.mjs'], consumer);
   const subject = upgradeFromPublished
      ? `Prerelease upgrade from ${published} to candidate tarballs`
      : publishedPrerelease
        ? `Published prerelease ${published} consumer`
        : 'Packed consumer';
   process.stdout.write(`${subject}: compile, LSP and data requests passed.\n`);
} finally {
   if (process.env.HYDRANIUM_KEEP_PACKED_CONSUMER) {
      process.stdout.write(`Packed consumer kept at ${scratch}\n`);
   } else {
      rmSync(scratch, { recursive: true, force: true });
   }
}
