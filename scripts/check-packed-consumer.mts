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
// then upgrades the same consumer to the candidates. `--init-scaffold` makes the
// consumer an `init` scaffold instead, changed only in its `@hydranium/*`
// dependencies, so what is tested is what an adopter gets.
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
const initScaffold = process.argv.includes('--init-scaffold');

if ([negativeMissingPackageFile, publishedPrerelease, upgradeFromPublished, initScaffold].filter(Boolean).length > 1) {
   throw new Error(
      '--negative-missing-package-file, --published-prerelease, --upgrade-from-published and --init-scaffold are mutually exclusive'
   );
}

/** The npm bundled with the oldest Node the scaffold declares, which its first install has to survive. */
const SCAFFOLD_NPM = '10.9.2';

/** A scaffold smoke starts a server and makes a handful of requests; one that hangs fails at this. */
const SMOKE_TIMEOUT_MS = 2 * 60_000;

/** The npm a workspace root declares, which lifts the scaffold's `vitest` hold when it also runs `init`. */
const WORKSPACE_NPM = '11.15.0';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const example = join(root, 'examples/bookstore/server');
const scratch = mkdtempSync(join(tmpdir(), 'hydranium-packed-consumer-'));
const tarballs = join(scratch, 'tarballs');
const consumer = join(scratch, 'consumer');
const packageDirs = ['langium', 'protocol', 'core', 'data-server', 'glsp-server', ...(initScaffold ? ['cli'] : [])];
const env = { ...process.env, npm_config_workspaces: 'false' };

interface InstalledManifest {
   name?: string;
   version?: string;
}

/** Run a step to completion, failing it after `timeout` ms so a hang does not wait for the job's own limit. */
function run(label: string, program: string, args: string[], cwd: string, runEnv: NodeJS.ProcessEnv = env, timeout = 10 * 60_000): void {
   const result = spawnSync(program, args, { cwd, env: runEnv, stdio: 'inherit', timeout });
   if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
   if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

function packageName(directory: string): string {
   return (JSON.parse(readFileSync(join(root, 'packages', directory, 'package.json'), 'utf8')) as { name: string }).name;
}

function publishedBaseline(override: string | undefined): string {
   const version: string | undefined =
      override || JSON.parse(execFileSync('npm', ['view', '@hydranium/core', 'dist-tags.latest', '--json'], { encoding: 'utf8' }));
   if (!version || !/-next\./.test(version)) {
      const source = override ? 'HYDRANIUM_UPGRADE_FROM' : 'dist-tag latest';
      throw new Error(`expected a published prerelease from ${source}, found ${version ?? 'nothing'}`);
   }
   return version;
}

/** Pack every framework package into `tarballs`, answering name → `file:` specifier. */
function packCandidates(): Map<string, string> {
   const candidates = new Map<string, string>();
   for (const directory of packageDirs) {
      const output = execFileSync('npm', ['pack', '--json', '--pack-destination', tarballs], {
         cwd: join(root, 'packages', directory),
         encoding: 'utf8'
      });
      const filename = (JSON.parse(output) as { filename?: string }[])[0]?.filename;
      if (!filename) throw new Error(`npm pack produced no tarball for ${directory}`);
      candidates.set(packageName(directory), `file:${join(tarballs, filename)}`);
   }
   return candidates;
}

/** The bookstore server's declared version of `name`. */
function bookstoreDependency(name: string): string {
   const sourcePackage = JSON.parse(readFileSync(join(example, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
   const dependencySpec = sourcePackage.dependencies?.[name];
   if (dependencySpec === undefined) throw new Error(`the bookstore server declares no ${name}`);
   return dependencySpec;
}

/** The `vscode-jsonrpc` a published release peers, which a consumer installing it under `--strict-peer-deps` has to declare. */
function publishedTransport(version: string): string {
   return execFileSync('npm', ['view', `@hydranium/protocol@${version}`, 'peerDependencies.vscode-jsonrpc'], {
      env,
      encoding: 'utf8'
   }).trim();
}

/** Write the consumer project: the bookstore server's source and dependencies, with `packages` pinned. */
function writeConsumer(packages: Map<string, string>): void {
   const sourcePackage = JSON.parse(readFileSync(join(example, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
   const dependencies: Record<string, string> = { ...sourcePackage.dependencies };
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
            devDependencies: { '@types/node': '^22.0.0', typescript: '^5.8.0' }
         },
         null,
         2
      )}\n`
   );
   cpSync(join(example, 'src'), join(consumer, 'src'), { recursive: true });
   cpSync(join(root, 'scripts/fixtures/packed-consumer/smoke.mjs'), join(consumer, 'smoke.mjs'));
   const base = JSON.parse(readFileSync(join(root, 'tsconfig.base.json'), 'utf8')) as { compilerOptions?: Record<string, unknown> };
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
function repointConsumer(packages: Map<string, string>): void {
   const manifestPath = join(consumer, 'package.json');
   const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> };
   for (const [name, dependencySpec] of packages) manifest.dependencies[name] = dependencySpec;
   writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Point every framework package a manifest declares at `packages`, and add the
 * framework peers they need, which npm would otherwise fetch from the registry,
 * to the block of the package that needs them, `dependencies` when a runtime
 * package does. Answers what it repointed.
 */
function repointFramework(manifestPath: string, packages: Map<string, string>): Map<string, string> {
   type Block = 'dependencies' | 'devDependencies';
   const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<Block, Record<string, string>>;
   const directories = new Map(packageDirs.map(directory => [packageName(directory), directory]));
   const declared = (name: string): Block | undefined =>
      name in manifest.dependencies ? 'dependencies' : name in manifest.devDependencies ? 'devDependencies' : undefined;
   const pending: Array<readonly [string, Block]> = (['dependencies', 'devDependencies'] as const).flatMap(block =>
      Object.keys(manifest[block])
         .filter(name => packages.has(name))
         .map(name => [name, block] as const)
   );
   const placed = new Map<string, Block>();
   for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const [name, neededBy] = next;
      const block = declared(name) ?? neededBy;
      const directory = directories.get(name);
      if (placed.get(name) === 'dependencies' || placed.get(name) === block || directory === undefined) continue;
      placed.set(name, block);
      const peers = (
         JSON.parse(readFileSync(join(root, 'packages', directory, 'package.json'), 'utf8')) as {
            peerDependencies?: Record<string, string>;
         }
      ).peerDependencies;
      pending.push(
         ...Object.keys(peers ?? {})
            .filter(peer => packages.has(peer))
            .map(peer => [peer, block] as const)
      );
   }
   const repointed = new Map<string, string>();
   for (const [name, block] of placed) {
      const dependencySpec = packages.get(name)!;
      manifest[block][name] = dependencySpec;
      repointed.set(name, dependencySpec);
   }
   writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
   return repointed;
}

/**
 * Assert each framework package is a real directory, named as expected, and
 * came from where its specifier says: a `file:` tarball, or exactly the
 * published version from the registry.
 */
function assertInstalledFrom(packages: Map<string, string>, installRoot = consumer): void {
   const lock = JSON.parse(readFileSync(join(installRoot, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { resolved?: string }>;
   };
   for (const [name, dependencySpec] of packages) {
      const installedDir = join(installRoot, 'node_modules', name);
      const manifest = join(installedDir, 'package.json');
      const resolved = String(lock.packages?.[`node_modules/${name}`]?.resolved);
      const installed = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, 'utf8')) as InstalledManifest) : undefined;
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

const WIRE_STACK_PINS: ReadonlyArray<readonly [string, string]> = [
   ['langium', '4.3.1'],
   ['vscode-jsonrpc', '9.0.0'],
   ['vscode-languageserver-protocol', '3.18.1']
];

/** Assert `pins` resolved at the top of the tree, and `singles` to one physical copy each. */
function assertSingleCopies(
   singles: string[],
   pins: ReadonlyArray<readonly [string, string]> = WIRE_STACK_PINS,
   installRoot = consumer,
   lsEnv: NodeJS.ProcessEnv = env
): void {
   for (const [name, version] of pins) {
      const installed = JSON.parse(readFileSync(join(installRoot, 'node_modules', name, 'package.json'), 'utf8')) as InstalledManifest;
      if (installed.version !== version) throw new Error(`${name} resolved to ${installed.version}, expected ${version}`);
   }
   const physical = execFileSync('npm', ['ls', ...singles, '--all', '--parseable'], {
      cwd: installRoot,
      env: lsEnv,
      encoding: 'utf8'
   })
      .trim()
      .split('\n');
   for (const name of singles) {
      const copies = physical.filter(path => path.endsWith(`/node_modules/${name}`));
      if (copies.length !== 1) throw new Error(`expected one physical ${name} install, found ${copies.length}`);
   }
}

/**
 * Assert one physical 9.x `vscode-jsonrpc`. A second leaves an LSP handler's
 * framework error without its code; the 8.x copies `@eclipse-glsp/*` nest are its own.
 */
function assertOneTransport(installRoot: string, lsEnv: NodeJS.ProcessEnv): void {
   const copies = execFileSync('npm', ['ls', 'vscode-jsonrpc', '--all', '--parseable'], { cwd: installRoot, env: lsEnv, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(path => path.endsWith('/node_modules/vscode-jsonrpc'))
      .filter(path => (JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as InstalledManifest).version?.startsWith('9.'));
   if (copies.length !== 1)
      throw new Error(`expected one physical 9.x vscode-jsonrpc install, found ${copies.length}: ${copies.join(', ')}`);
}

const install = ['install', '--strict-peer-deps', '--no-audit', '--no-fund'];

/** One scaffold the check installs, and how. */
interface ScaffoldShape {
   readonly label: string;
   readonly heads: string;
   /** Scaffold as a member of a fresh workspace. */
   readonly monorepo?: boolean;
   /** Reinstall with `--omit=dev` and smoke again, as a deployment does. */
   readonly production?: boolean;
   /** The npm that runs `init` and installs; {@link SCAFFOLD_NPM} by default. */
   readonly npm?: string;
   /** The `vitest` range `init` must emit. */
   readonly vitest: string;
}

const SCAFFOLD_SHAPES: readonly ScaffoldShape[] = [
   { label: 'standalone, all heads', heads: 'lsp,data,glsp', production: true, vitest: '~4.0.18' },
   { label: 'standalone, LSP and data', heads: 'lsp,data', vitest: '~4.0.18' },
   { label: 'standalone, LSP and GLSP', heads: 'lsp,glsp', vitest: '~4.0.18' },
   { label: 'standalone, LSP only', heads: 'lsp', vitest: '~4.0.18' },
   { label: 'workspace member, all heads', heads: 'lsp,data,glsp', monorepo: true, vitest: '~4.0.18' },
   { label: 'workspace member under its root npm, LSP only', heads: 'lsp', monorepo: true, npm: WORKSPACE_NPM, vitest: '^4.0.0' }
];

/** The packed CLI installed on its own, so `init` runs from what an adopter downloads, with its framework peers packed too. */
function installPackedCli(candidates: Map<string, string>): string {
   const runner = join(scratch, 'cli-runner');
   mkdirSync(runner);
   const manifestPath = join(runner, 'package.json');
   writeFileSync(
      manifestPath,
      `${JSON.stringify({ name: 'cli-runner', private: true, dependencies: { '@hydranium/cli': candidates.get('@hydranium/cli') }, devDependencies: {} }, null, 2)}\n`
   );
   const repointed = repointFramework(manifestPath, candidates);
   run('Packed CLI install', 'npm', install, runner);
   assertInstalledFrom(repointed, runner);
   return join(runner, 'node_modules/@hydranium/cli/bin/hydranium-cli.js');
}

/** Scaffold one shape with the packed CLI, install it with the floor npm, then build, test and smoke it. */
function checkScaffoldShape(shape: ScaffoldShape, index: number, cli: string, candidates: Map<string, string>): void {
   const installRoot = join(scratch, `scaffold-${index}`);
   const project = shape.monorepo ? join(installRoot, 'packages/my-lang') : installRoot;
   const init = [cli, 'init', project, '--name', 'MyLang', '--heads', shape.heads];
   // A workspace has to see its members, which the inherited setting would hide, and
   // npm refuses it for any script run inside a member.
   const installEnv = shape.monorepo ? { ...process.env, npm_config_workspaces: undefined } : env;
   const npm = shape.npm ?? SCAFFOLD_NPM;
   const shapeInstall = (label: string, args = install) =>
      run(`${shape.label}: ${label} (npm ${npm})`, 'npx', ['--yes', `npm@${npm}`, ...args], installRoot, installEnv);
   // `init` as an adopter's `npx` under that npm runs it, whatever npm runs this check.
   const initEnv = { ...env, npm_config_user_agent: `npm/${npm} node/${process.version} ${process.platform} ${process.arch}` };

   if (shape.monorepo) {
      mkdirSync(installRoot);
      // A root declaring a newer npm than the one installing it, which npm does not enforce.
      writeFileSync(
         join(installRoot, 'package.json'),
         `{ "name": "scaffold-workspace", "private": true, "packageManager": "npm@${WORKSPACE_NPM}", "workspaces": ["packages/*"] }\n`
      );
      run(`${shape.label}: scaffold`, 'node', [...init, '--monorepo'], installRoot, initEnv);
   } else {
      run(`${shape.label}: scaffold`, 'node', init, scratch, initEnv);
   }
   const vitest = (JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> })
      .devDependencies?.vitest;
   if (vitest !== shape.vitest) throw new Error(`${shape.label}: init emitted vitest ${vitest}, expected ${shape.vitest}`);
   const repointed = repointFramework(join(project, 'package.json'), candidates);
   cpSync(join(root, 'scripts/fixtures/packed-consumer/scaffold-smoke.mjs'), join(project, 'scaffold-smoke.mjs'));

   shapeInstall('install');
   assertInstalledFrom(repointed, installRoot);
   for (const name of candidates.keys()) {
      if (!repointed.has(name) && existsSync(join(installRoot, 'node_modules', name))) {
         throw new Error(`${shape.label}: installed ${name}, which the scaffold does not declare`);
      }
   }
   // GLSP's server and graph pin their protocol exactly, so a second copy means something declared another release.
   const glspSingles = shape.heads.split(',').includes('glsp') ? ['@eclipse-glsp/protocol'] : [];
   assertSingleCopies(['langium', 'vscode-languageserver-protocol', ...glspSingles], [['langium', '4.3.1']], installRoot, installEnv);
   assertOneTransport(installRoot, installEnv);
   run(`${shape.label}: build`, 'npm', ['run', 'build'], project, installEnv);
   run(`${shape.label}: tests`, 'npm', ['test'], project, installEnv);
   run(`${shape.label}: smoke`, 'node', ['scaffold-smoke.mjs', shape.heads], project, env, SMOKE_TIMEOUT_MS);
   if (shape.production) {
      rmSync(join(installRoot, 'node_modules'), { recursive: true, force: true });
      shapeInstall('production install', ['ci', '--omit=dev', '--no-audit', '--no-fund']);
      run(
         `${shape.label}: smoke after the production install`,
         'node',
         ['scaffold-smoke.mjs', shape.heads],
         project,
         env,
         SMOKE_TIMEOUT_MS
      );
   }
   process.stdout.write(`init scaffold, ${shape.label}: passed.\n`);
}

/** Every scaffold shape, each scaffolded by the packed CLI. */
function checkInitScaffold(): void {
   const candidates = packCandidates();
   const cli = installPackedCli(candidates);
   SCAFFOLD_SHAPES.forEach((shape, index) => checkScaffoldShape(shape, index, cli, candidates));
}

/** Install the bookstore consumer, optionally from the published prerelease, then compile and smoke it. */
function checkBookstoreConsumer(): void {
   mkdirSync(consumer);
   const published =
      publishedPrerelease || upgradeFromPublished
         ? publishedBaseline(upgradeFromPublished ? process.env.HYDRANIUM_UPGRADE_FROM : undefined)
         : undefined;
   if (upgradeFromPublished) {
      process.stdout.write(`Upgrading from ${published} (set HYDRANIUM_UPGRADE_FROM to repeat this run).\n`);
   }
   const candidates = publishedPrerelease ? undefined : packCandidates();
   const first = new Map(packageDirs.map(directory => [packageName(directory), published ?? candidates!.get(packageName(directory))!]));

   // A published release peers the transport it shipped with, which need not be the bookstore's.
   writeConsumer(published ? new Map([...first, ['vscode-jsonrpc', publishedTransport(published)]]) : first);
   run(published ? `Prerelease resolution (${published})` : 'Candidate resolution', 'npm', install, consumer);
   if (negativeMissingPackageFile) {
      // Control mode: prove the package-file assertion is load-bearing by
      // removing a required installed manifest before validation. The command
      // is expected to fail with the package-installation error below.
      rmSync(join(consumer, 'node_modules', '@hydranium/core', 'package.json'));
   }
   assertInstalledFrom(first);

   if (upgradeFromPublished) {
      repointConsumer(new Map([...candidates!, ['vscode-jsonrpc', bookstoreDependency('vscode-jsonrpc')]]));
      run('Candidate migration to tarballs', 'npm', install, consumer);
      assertInstalledFrom(candidates!);
   }

   // The single copies are the candidate's promise; a release from before it held them only
   // through this repository's overrides, which a consumer does not get.
   if (!publishedPrerelease) {
      assertSingleCopies(['langium', 'vscode-languageserver-protocol']);
      assertOneTransport(consumer, env);
   }
   run('Consumer compile', 'npm', ['exec', '--', 'tsc', '-p', 'tsconfig.json'], consumer);
   run('Consumer LSP and data smoke', 'node', ['smoke.mjs'], consumer);
   const subject = upgradeFromPublished
      ? `Prerelease upgrade from ${published} to candidate tarballs`
      : publishedPrerelease
        ? `Published prerelease ${published} consumer`
        : 'Packed consumer';
   process.stdout.write(`${subject}: compile, LSP and data requests passed.\n`);
}

try {
   mkdirSync(tarballs);
   if (initScaffold) {
      checkInitScaffold();
   } else {
      checkBookstoreConsumer();
   }
} finally {
   if (process.env.HYDRANIUM_KEEP_PACKED_CONSUMER) {
      process.stdout.write(`Packed consumer kept at ${scratch}\n`);
   } else {
      rmSync(scratch, { recursive: true, force: true });
   }
}
