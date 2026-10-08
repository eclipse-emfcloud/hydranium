/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// CI scope: decide whether a pull request changed only prose, so CI can skip
// the jobs prose cannot affect and still run the gates that read it.
//
// The list below is a PROSE list and it is short on purpose. Anything it does
// not match runs everything, and so does an empty diff, because the failure
// modes are asymmetric: a needless full run costs minutes, while a skipped run
// on a change that needed one merges untested.
//
// CI runs the base commit's copy, so a change here applies from the next pull
// request on, and the one making it is judged by the list as it was. It runs
// that copy from outside the checkout, so classifying must stay one file that
// reads nothing but stdin; only the self-test reads the repository.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';

type ProseRule = (path: string) => boolean;

/** Example workspaces are fixture trees that tests and e2e copy, prose or not. */
const isFixture = (path: string): boolean => /^examples\/[^/]+\/workspace\//.test(path);

/** A package's source, test and script trees are turbo inputs of its build, test and lint. */
const isPackageTree = (path: string): boolean => /(^|\/)(src|test|scripts)\//.test(path);

/**
 * Files under a prose path that a build reads anyway, so a change to one ships without e2e if it
 * passes for prose. The self-test fails when a CI turbo task hashes a file the rules call prose.
 */
const BUILD_INPUTS = new Set(['docs/assets/hydranium-logo.svg']);

const PROSE: ProseRule[] = [
   // Pages and their images, read by the docs gates.
   path => path.startsWith('docs/'),
   // Markdown outside the example workspaces and the package trees, read by the docs gates.
   path => path.endsWith('.md') && !isFixture(path) && !isPackageTree(path),
   // Read only by check:docs, which the prose gate runs.
   path => path === 'scripts/check-docs-baseline.json'
];

/** Whether every changed path is prose. `rules` is a parameter so the self-test can empty it. */
function isProseOnly(paths: string[], rules: ProseRule[] = PROSE): { proseOnly: boolean; why: string; code: string[] } {
   if (paths.length === 0) {
      return { proseOnly: false, why: 'the diff resolved to no changed path, so nothing rules a full run out', code: [] };
   }
   const code = paths.filter(path => BUILD_INPUTS.has(path) || !rules.some(rule => rule(path)));
   return code.length === 0
      ? { proseOnly: true, why: `all ${paths.length} changed path(s) are prose`, code }
      : { proseOnly: false, why: `${code.length} of ${paths.length} changed path(s) are not prose`, code };
}

/** Real pull requests, with the scope each should have had, and the near misses. */
const FIXTURES = [
   {
      name: 'a docs-only correction across READMEs and pages is prose',
      paths: ['README.md', 'SECURITY.md', 'docs/adopting/status.md', 'packages/core/README.md', 'examples/order-flow/server/README.md'],
      proseOnly: true
   },
   {
      name: 'a page with its image is prose',
      paths: ['docs/README.md', 'docs/assets/demo-dark.png', 'docs/img/architecture.svg'],
      proseOnly: true
   },
   { name: 'an issue template is prose', paths: ['.github/ISSUE_TEMPLATE/question.md'], proseOnly: true },
   { name: 'a gate script beside docs runs everything', paths: ['README.md', 'scripts/check-readme-snippet.mts'], proseOnly: false },
   {
      name: 'a page with the docs gate baseline it lowers is prose',
      paths: ['docs/ADOPTING.md', 'scripts/check-docs-baseline.json'],
      proseOnly: true
   },
   { name: 'the docs gate itself runs everything', paths: ['scripts/check-docs.mts'], proseOnly: false },
   {
      name: 'an example workspace README is a fixture and runs everything',
      paths: ['examples/order-flow/workspace/README.md'],
      proseOnly: false
   },
   {
      name: 'the brand logo the browser example builds in runs everything',
      paths: ['docs/assets/hydranium-logo.svg'],
      proseOnly: false
   },
   {
      name: 'markdown in a package source or test tree runs everything',
      paths: ['packages/protocol/src/rpc/README.md', 'packages/core/test/fixtures/sample.md'],
      proseOnly: false
   },
   { name: 'a workflow change runs everything', paths: ['.github/workflows/ci.yml'], proseOnly: false },
   { name: 'shipped source runs everything', paths: ['packages/core/src/index.ts'], proseOnly: false },
   { name: 'an empty diff runs everything', paths: [], proseOnly: false }
];

/** A job or step and its `if:`, empty when it has none. */
type Guarded = { name: string; condition: string };

function jobsOf(workflow: string): Guarded[] {
   const jobs: Guarded[] = [];
   let inJobs = false;
   for (const line of workflow.split('\n')) {
      if (line === 'jobs:') {
         inJobs = true;
      } else if (inJobs && /^  [a-z][\w-]*:$/.test(line)) {
         jobs.push({ name: line.trim().slice(0, -1), condition: '' });
      } else if (jobs.length > 0 && line.startsWith('    if: ')) {
         jobs[jobs.length - 1].condition = line.slice('    if: '.length);
      }
   }
   return jobs;
}

/** The `build` job's steps and job-level env; no steps when ci.yml has no `build` job. */
function buildJobOf(workflow: string): { steps: Guarded[]; env: Map<string, string> } {
   const lines = workflow.split('\n');
   const start = lines.indexOf('  build:');
   const end = lines.findIndex((line, index) => index > start && /^  [a-z][\w-]*:$/.test(line));
   const steps: Guarded[] = [];
   const env = new Map<string, string>();
   for (const line of start === -1 ? [] : lines.slice(start, end === -1 ? undefined : end)) {
      const variable = /^ {6}([A-Z][A-Z0-9_]*): (.*)$/.exec(line);
      if (variable) {
         env.set(variable[1], variable[2]);
      } else if (line.startsWith('      - ')) {
         steps.push({ name: /name: (.*)$/.exec(line)?.[1] ?? line.trim(), condition: '' });
      } else if (line.startsWith('        if: ') && steps.length > 0) {
         steps[steps.length - 1].condition = line.slice('        if: '.length);
      }
   }
   return { steps, env };
}

/**
 * Jobs without a status function in their `if:`. The scope job is skipped on every push, and GitHub
 * can skip a job whose chain of needs holds a skipped job unless its condition says otherwise, so
 * every job but the scope job states one rather than leaving the self-test to trace the chain.
 */
function jobsWithoutStatusFunction(jobs: Guarded[]): string[] {
   if (jobs.length < 2) {
      return ['<no jobs found>'];
   }
   return jobs
      .filter(job => job.name !== 'changes' && !job.condition.includes('!cancelled()') && !job.condition.includes('always()'))
      .map(job => job.name);
}

/** The `build` job's steps whose `if:` neither names the prose verdict nor confines the step to the Ubuntu leg. */
function buildStepsWithoutProseGuard(steps: Guarded[]): string[] {
   if (steps.length === 0) {
      return ['<no build job found>'];
   }
   return steps
      .filter(step => !step.condition.includes('PROSE_ONLY') && !step.condition.includes("matrix.os == 'ubuntu-22.04'"))
      .map(step => step.name);
}

/**
 * The guards that keep a full verdict testing, compared whole. One turned the wrong way still names
 * the prose verdict and a status function, so the presence checks pass while a full run builds,
 * tests nothing, and reports every required check green.
 */
const PINNED_GUARDS = {
   jobs: {
      build: '${{ !cancelled() }}',
      'e2e-chromium': "${{ !cancelled() && inputs.skip_e2e != true && needs.changes.outputs.full != 'false' }}",
      'e2e-vscode': "${{ !cancelled() && inputs.skip_e2e != true && needs.changes.outputs.full != 'false' }}",
      scaffold: "${{ !cancelled() && needs.changes.outputs.full != 'false' }}"
   },
   steps: {
      'Full gate': "env.PROSE_ONLY != 'true'",
      'Prose gate': "env.PROSE_ONLY == 'true' && env.PROSE_ONLY_LEG != 'true'"
   },
   env: {
      PROSE_ONLY: "${{ needs.changes.outputs.full == 'false' }}",
      PROSE_ONLY_LEG: "${{ needs.changes.outputs.full == 'false' && matrix.os != 'ubuntu-22.04' }}"
   }
};

/** Each pinned guard that ci.yml spells differently, or lacks. */
function guardsNotAsPinned(jobs: Guarded[], build: { steps: Guarded[]; env: Map<string, string> }): string[] {
   const actual = [
      ...Object.entries(PINNED_GUARDS.jobs).map(([name, pinned]) => [
         `job "${name}" if:`,
         jobs.find(job => job.name === name)?.condition,
         pinned
      ]),
      ...Object.entries(PINNED_GUARDS.steps).map(([name, pinned]) => [
         `build step "${name}" if:`,
         build.steps.find(step => step.name === name)?.condition,
         pinned
      ]),
      ...Object.entries(PINNED_GUARDS.env).map(([name, pinned]) => [`build env ${name}`, build.env.get(name), pinned])
   ];
   return actual
      .filter(([, found, pinned]) => found !== pinned)
      .map(([what, found, pinned]) => `${what} is \`${found ?? '<missing>'}\`, pinned as \`${pinned}\``);
}

/** Tasks that may hash every file of their package, because no CI run reaches them. */
const TASKS_OUTSIDE_CI: Record<string, string> = {
   watch: 'a local rebuild loop',
   clean: 'removes build output, from the local `npm run clean` only',
   start: 'runs a server locally'
};

/**
 * Every file a CI turbo task hashes, as a repository path, from turbo's own dry run, so the inputs
 * are turbo's resolution of its globs, `../` paths, negations and defaults rather than a reading of
 * `turbo.json`.
 */
function turboHashedFiles(): string[] {
   const tasks = new Set<string>();
   for (const file of execFileSync('git', ['ls-files', 'turbo.json', '**/turbo.json'], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
      // turbo.json takes whole-line comments, which JSON does not.
      const json = readFileSync(file, 'utf8')
         .split('\n')
         .filter(line => !line.trim().startsWith('//'))
         .join('\n');
      for (const task of Object.keys(JSON.parse(json).tasks ?? {})) {
         if (!(task in TASKS_OUTSIDE_CI)) {
            tasks.add(task);
         }
      }
   }
   const dryRun: {
      globalCacheInputs: { files?: Record<string, string> };
      tasks: { directory: string; inputs?: Record<string, string> }[];
   } = JSON.parse(
      execFileSync('turbo', ['run', ...tasks, '--dry=json'], {
         encoding: 'utf8',
         maxBuffer: 256 * 1024 * 1024,
         stdio: ['ignore', 'pipe', 'pipe']
      })
   );
   const files = new Set(Object.keys(dryRun.globalCacheInputs.files ?? {}));
   for (const task of dryRun.tasks) {
      for (const input of Object.keys(task.inputs ?? {})) {
         files.add(posix.normalize(`${task.directory}/${input}`));
      }
   }
   return [...files];
}

function selfTest(): void {
   let failed = false;
   for (const fixture of FIXTURES) {
      const actual = isProseOnly(fixture.paths).proseOnly;
      if (actual !== fixture.proseOnly) {
         console.error(`✗ self-test: ${fixture.name} — expected proseOnly=${fixture.proseOnly}, got ${actual}`);
         failed = true;
      }
   }
   // With nothing counted as prose every fixture runs everything, so one that expects prose must disagree.
   if (!FIXTURES.some(fixture => isProseOnly(fixture.paths, []).proseOnly !== fixture.proseOnly)) {
      console.error('✗ self-test: emptying the prose list changed no verdict, so the fixtures do not exercise it');
      failed = true;
   }
   // A file a CI turbo task hashes is not prose, whatever directory it sits in.
   const hashed = turboHashedFiles();
   for (const file of hashed.filter(path => isProseOnly([path]).proseOnly)) {
      console.error(
         `✗ self-test: a CI turbo task hashes ${file}, but it classifies as prose — list it in BUILD_INPUTS, or keep its tree out of the prose rules`
      );
      failed = true;
   }
   if (hashed.length === 0) {
      console.error('✗ self-test: the turbo dry run listed no input, so the build-input check checks nothing');
      failed = true;
   }
   // A prose-only Windows or macOS leg has no checkout, so a build step that would run there has to
   // say so: its condition names the prose verdict, or confines it to the Ubuntu leg, which builds.
   const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
   const jobs = jobsOf(workflow);
   const build = buildJobOf(workflow);
   for (const job of jobsWithoutStatusFunction(jobs)) {
      console.error(
         `✗ self-test: ci.yml job "${job}" has no !cancelled() or always() in its if:, so a push, which skips the scope job, can skip it too`
      );
      failed = true;
   }
   for (const step of buildStepsWithoutProseGuard(build.steps)) {
      console.error(
         `✗ self-test: ci.yml build step "${step}" names neither PROSE_ONLY nor the Ubuntu leg in its \`if:\`, so it runs on a prose-only leg with no checkout`
      );
      failed = true;
   }
   for (const drift of guardsNotAsPinned(jobs, build)) {
      console.error(`✗ self-test: ci.yml ${drift}, and a guard turned the wrong way lets a full run pass without testing`);
      failed = true;
   }
   if (failed) {
      process.exit(1);
   }
   console.log(
      `✓ self-test: ${FIXTURES.length} cases classify as specified, an emptied prose list changes the verdict, none of the ${hashed.length} files CI turbo tasks hash is prose, every job but the scope job states a status function, every ci.yml build step names its prose guard, and the guards that keep a full run testing are as pinned`
   );
}

if (process.argv.includes('--self-test')) {
   selfTest();
} else {
   const paths = readFileSync(0, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
   const verdict = isProseOnly(paths);
   const report = [
      `- verdict: \`${verdict.proseOnly ? 'prose only' : 'full'}\` — ${verdict.why}`,
      ...verdict.code.map(path => `- not prose: \`${path}\``)
   ];

   console.log(`full=${!verdict.proseOnly}`);
   for (const line of report) {
      console.log(line.replaceAll('`', ''));
   }
   if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${['### CI scope', ...report].join('\n')}\n`);
   }
   if (verdict.proseOnly && process.env.GITHUB_ACTIONS) {
      console.log(
         '::notice title=Prose-only change::e2e, the init scaffold and the Windows and macOS gates are skipped; the docs gates still run.'
      );
   }
   // Last, so a step that fails anywhere before this leaves no verdict, and no verdict runs everything.
   if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `full=${!verdict.proseOnly}\n`);
   }
}
