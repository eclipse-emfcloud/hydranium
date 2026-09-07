#!/usr/bin/env node
/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `init`-provenance gate for the examples that claim to have been scaffolded by
 * `hydranium-cli init`.
 *
 * Each target carries a per-file table saying which files are still the
 * scaffold's and which were adapted. This gate makes that table executable.
 *
 * Why it exists: prose about provenance rots exactly as fast as any other
 * uncheckable claim, so a table nobody executes drifts from the files it
 * describes within a commit or two.
 *
 * What it checks, for every file `init` emits:
 * - `identical` — matches the template output byte for byte, once the example's
 *   SPDX header is stripped. This is the claim with teeth.
 * - `adapted` — must exist AND differ. Catches a stale label in both
 *   directions: a file that silently drifted back into sync is as much a
 *   documentation bug as one that drifted out. A bare `adapted` waives the
 *   whole file, so an entry that can name the fields the adaptation is about
 *   lists them in `exempt` and every other field is still compared; on a
 *   manifest, that remainder is most of what the gate exists to check.
 * - `replaced` — the scaffolded path is gone and a named successor exists.
 * - `dropped` — deliberately absent, with nothing standing in for it.
 *
 * It also asserts each manifest covers exactly what `init` emits, so adding a
 * template file fails here until someone decides what every example does with it.
 *
 * **TWO invocations, not one, and they pin different things.** `order-flow` is
 * recorded at the DEFAULT head set, because its diagram runs the reconciling
 * multi-document strategy — a different set of classes from the one `--diagram`
 * emits, not a customisation of it. So the GLSP template path — the largest
 * thing `init` writes — was golden-only until `bookstore` was recorded beside it
 * at `--heads lsp,data,glsp` (the diagram is derived from there, see
 * {@link BOOKSTORE_INVOCATION}). One target cannot hold both: the head set is a
 * property of the invocation, and a scaffold rendered at three heads does not
 * describe a two-head example.
 *
 * The two also differ in what a green verdict MEANS. `order-flow` is adapted
 * almost everywhere, so its value is that each divergence stays deliberate;
 * `bookstore` is `identical` everywhere but one file, so its value is that the
 * default scaffold is checked against a project that is really built, tested and
 * linted in CI. That second claim is the one that decays if `bookstore` grows
 * hand-written additions — an adapted provenance target pins nothing.
 *
 * Usage:
 *   node scripts/check-init-provenance.mjs            # verify; exit 1 on drift
 *   node scripts/check-init-provenance.mjs --write     # re-derive the `identical` files
 *
 * `--write` exists because nothing else in the repo writes an example back, so
 * every template change was re-synced by hand — and a hand re-sync is what makes
 * a provenance target drift in the first place. It touches only what the
 * manifest says is the scaffold's — an `identical` entry in full, an `exempt`
 * one everywhere outside its named fields; see {@link writeTarget}. What it
 * lays down is the template's own text, which is not always the formatter's, so
 * format what it wrote before reading any other gate's verdict.
 *
 * A SECOND claim rides along, over the same re-derived scaffold: every
 * third-party version the scaffold pins still matches the manifest this repo
 * declares it in. See {@link SCAFFOLD_PIN_SOURCES} for why that belongs here.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 8-line SPDX block plus the blank line after it, which the scaffold does not emit. */
const HEADER_LINES = 9;

/**
 * Split a leading `#!` shebang off its file, since it stays ahead of the header.
 *
 * The `bin` entries the scaffold emits carry one, and it has to be the very
 * first line for the interpreter to find it — so `scripts/header.mjs` writes the
 * SPDX block BELOW it. Everything here that reasons about "line 1 is the header"
 * therefore has to reason about line 2 as well: a shebang-first file otherwise
 * fails the `startsWith('/****')` test, the header is not stripped, and every
 * comparison on that file misaligns by nine lines while the content is in fact
 * identical.
 */
function splitShebang(text) {
   const match = /^#![^\n]*\n/.exec(text);
   return match === null ? { shebang: '', body: text } : { shebang: match[0], body: text.slice(match[0].length) };
}

/**
 * The scaffold invocation `order-flow` was created with, as its README documents
 * it.
 *
 * All three grammars, so the gate compares a three-language scaffold against a
 * three-language example. Nothing beyond the names: `--language-id` and
 * `--extensions` are both absent because `--grammar Domain` derives
 * `order-flow-domain` and `.domain` on its own, which is what the example
 * actually has — and the same holds for `Layout`/`.layout`.
 */
const ORDER_FLOW_INVOCATION = {
   name: 'OrderFlow',
   grammars: [{ name: 'Domain' }, { name: 'Process' }, { name: 'Layout' }],
   // The example IS a workspace member, so the recorded invocation says so. This
   // is what lets `tsconfig.json` be checked as 'identical' rather than waved
   // through as 'adapted': the scaffold derives the `extends` and the pruned
   // option set from the repo it is being written into, and the gate now proves
   // that derivation still reproduces the checked-in file.
   monorepo: true
};

/**
 * Per-emitted-path provenance for `order-flow`. Keys must match `init`'s output
 * exactly; each `reason` is the sentence the target's provenance table is
 * expected to agree with.
 *
 * **That agreement is NOT machine-checked — this gate never reads a README** —
 * so a reason is only as good as the last person to look at the actual diff.
 * Three of these said something false as recently as 2026-08-31 (that the
 * fragment carries extra terminals, that the scaffolded test asserts one
 * language, that `--monorepo` derives `"private"`), all three surviving because
 * the VERDICT was right and nothing reads the sentence beside it. When a verdict
 * flips, re-read the diff rather than the reason.
 */
const ORDER_FLOW_MANIFEST = {
   // `--monorepo` derives the `--prefix` in the regen command. Everything else
   // that differs is either example-specific or a consequence of the hand-added
   // GLSP head, and there is a lot of it: the descriptive `example-` package
   // name, an example-specific `description` and an MIT `license` where the
   // scaffold emits a templated sentence and UNLICENSED, the `homepage` /
   // `repository` pair no scaffold can learn, the `order-flow-server` rename of
   // the first `bin` key — the second is the scaffold's, emitted with the data
   // head — the bench / lint / measure-memory scripts, the
   // `@eclipse-glsp/*` + `inversify` + `reflect-metadata` runtime set the
   // reconciling diagram needs, and loosened `langium` / `langium-cli` ranges.
   // `"private": true` is NOT in that list: it is the scaffold's default, so the
   // example carrying it is derivation rather than adaptation.
   'package.json': {
      verdict: 'adapted',
      reason: "the example's own name and metadata, a second bin, extra scripts, and the GLSP head's dependencies"
   },
   // This example predates the member `.gitignore` template, so the repo root
   // ignores its `syntaxes/` by wildcard instead. Adding the file would be
   // correct and would also be the only reason this package has one, so it is
   // recorded as dropped rather than backfilled — and the root pattern has to
   // stay either way, since it is what covers this example.
   '.gitignore': { verdict: 'dropped', reason: "the repo root's wildcard covers this example's syntaxes/" },
   // The recorded invocation emits exactly the three language entries, ids,
   // extensions and TextMate paths the example has — the gate's strongest claim.
   'langium-config.json': { verdict: 'identical', reason: 'the scaffold emits all three language entries' },
   // `--monorepo` derives this one in full: the `extends` target is found by
   // looking for the root tsconfig that carries `compilerOptions` (the repo
   // root's is a solution file), and the options are pruned to those the base
   // does not already supply with the same value.
   'tsconfig.json': { verdict: 'identical', reason: 'the scaffold derives the extends and the pruned option set' },
   'tsconfig.test.json': { verdict: 'identical', reason: 'the scaffold emits isolatedModules too' },
   'vitest.config.ts': { verdict: 'adapted', reason: "uses the repo's shared vitest config" },
   'README.md': { verdict: 'adapted', reason: 'rewritten as the tutorial' },
   // The scaffold emits these paths itself, so each entry is a plain 'adapted'.
   'src/grammar/domain.langium': { verdict: 'adapted', reason: 'the real grammar, replacing the starter one' },
   'src/grammar/process.langium': { verdict: 'adapted', reason: 'the real grammar, replacing the starter one' },
   'src/grammar/layout.langium': { verdict: 'adapted', reason: 'the real grammar, replacing the starter one' },
   // The THINNEST 'adapted' in either manifest, and worth knowing as such: the
   // example's token set is exactly the scaffold's four, so what differs is the
   // prose comment and the `ML_COMMENT` / `SL_COMMENT` order. The grammars' own
   // terminals live with them — `NUMBER` is declared in `layout.langium`. A
   // comment tidy here therefore flips the verdict, which is the gate working
   // rather than a false alarm, but only if this line says what the diff is.
   'src/grammar/common.langium': { verdict: 'adapted', reason: 'a fragment-specific comment, and the two comment terminals reordered' },
   'src/language-server/order-flow-module.ts': { verdict: 'adapted', reason: 'composes every language of the project' },
   'src/language-server/ast.ts': { verdict: 'adapted', reason: 'adds the cross-grammar computed-property augmentations' },
   // The scaffold emits these three paths and the example has all three at
   // exactly them, so each entry is a plain 'adapted' over the real syntax.
   'src/language-server/domain-serializer.ts': { verdict: 'adapted', reason: "emits the real grammar's syntax, not the starter one" },
   'src/language-server/process-serializer.ts': { verdict: 'adapted', reason: "emits the real grammar's syntax, not the starter one" },
   'src/language-server/layout-serializer.ts': { verdict: 'adapted', reason: "emits the real grammar's syntax, not the starter one" },
   'src/index.ts': { verdict: 'adapted', reason: "widened to the example's own surface" },
   'src/services.ts': { verdict: 'identical', reason: 'the contract is language-count-agnostic' },
   // The difference is the GLSP head: `init` can scaffold one, but on the
   // FULL-TEXT strategy, and this example's diagram is the reconciling
   // multi-document one — a different set of classes, not a customisation of
   // the scaffolded set. So the recorded invocation stays at the default heads,
   // and the GLSP template path is pinned by the `bookstore` target instead.
   'src/main.ts': { verdict: 'adapted', reason: 'adds the GLSP head, which this example wires on the reconciling strategy' },
   // Was hand-written until `init` learnt to emit it; what still differs is the
   // three-grammar comment on the transfer import, which names `.layout` as the
   // reason one data server carries every registered language. A template cannot
   // say that, and it is the sentence the example exists to make.
   'src/data-server-main.ts': { verdict: 'adapted', reason: "the transfer-import comment naming this project's third grammar" },
   'src/head-ports.ts': { verdict: 'adapted', reason: 'adds the GLSP command, which the default head set does not emit' },
   // NOT "the scaffolded test asserts one language" — rendered at THIS
   // three-grammar invocation it already asserts all three, being deliberately
   // grammar-agnostic. What the successor adds is the multi-grammar composition
   // itself: shared-tier identity, per-extension routing, per-language
   // serializers, the scope-provider overrides and the explicit
   // `lsp.configurationRoot` — none of which a one-language scaffold has to say.
   'test/services.test.ts': {
      verdict: 'replaced',
      by: 'test/composition.test.ts',
      reason: 'widened from "the languages are registered" to what composing several of them into one shared tier means'
   },
   // The scaffolded round-trip covers one grammar per suite over the starter
   // syntax; the successor covers three real ones, and its golden sibling pins
   // the emitted text of a whole workspace rather than of one parsed string.
   'test/serialization.test.ts': {
      verdict: 'replaced',
      by: 'test/serializer.test.ts',
      reason: 'widened to the three real grammars, with a workspace-wide golden beside it'
   },
   // This example asserts all three tiers, but over the real grammars and from
   // suites organised by SUBJECT rather than by tier — the scaffold's split is
   // for a reader with one grammar and no tests yet.
   'test/parsing.test.ts': { verdict: 'dropped', reason: 'the real grammars are parsed by every suite that loads the workspace fixture' },
   'test/linking.test.ts': {
      verdict: 'replaced',
      by: 'test/project-visibility.test.ts',
      reason: 'widened from "a reference resolves" to which tier exports it and who can see it across projects'
   },
   'test/validating.test.ts': {
      verdict: 'replaced',
      by: 'test/process-transition-rules.test.ts',
      reason: 'the example binds real checks, so it asserts those rather than the framework linker diagnostics'
   }
};

/**
 * The scaffold invocation `bookstore` was created with.
 *
 * One grammar and the GLSP head: this is the target that pins the seven-file
 * diagram emission plus the starter operation handler, none of which the
 * `order-flow` target reaches. `--diagram` is not recorded as a
 * field because with a single grammar the diagram is DERIVED — `resolveDiagrams`
 * marks the lone grammar when the head set includes `glsp`, so re-deriving the
 * composition here reproduces it without the flag.
 *
 * `"private": true` is likewise not a field: the scaffold emits it unless
 * `--public` asks otherwise, so the example carries it by derivation.
 */
const BOOKSTORE_INVOCATION = {
   name: 'Bookstore',
   grammars: [{ name: 'Bookstore' }],
   heads: ['lsp', 'data', 'glsp'],
   monorepo: true
};

/**
 * Per-emitted-path provenance for `bookstore`.
 *
 * Everything is `identical` but one file, and that is the point of the example
 * rather than an accident of its youth: it exists to be REGENERABLE from one
 * `init` invocation plus its grammar, so any second `adapted` line here is a
 * reason to reconsider the addition, not a line to add.
 */
const BOOKSTORE_MANIFEST = {
   // The ONE thing an in-repo example cannot take verbatim: sibling examples are
   // `@hydranium/example-<example>-<host>` and the scaffold emits a bare project
   // id, which no detection can supply because it encodes a convention rather
   // than a fact about the tree. The `lint` script used to be the second entry
   // here and is now emitted, the scaffold having learnt to read the root eslint
   // config — the manifest shrinking is the gate reporting a template gain.
   // Naming that one field is what keeps every other field compared: an
   // `adapted` entry with no `exempt` list waives the whole file, and a package
   // manifest is where a template gain goes unnoticed longest.
   'package.json': { verdict: 'adapted', exempt: ['name'], reason: 'the in-repo example package name' },
   // One rule — `syntaxes/` — which is the entry a workspace root cannot be
   // assumed to have. This repo's root also covers it by wildcard, so bookstore
   // is ignored twice; the overlap is inert (git ignore rules are additive) and
   // the root pattern has to stay for `order-flow`, which predates the template.
   '.gitignore': { verdict: 'identical', reason: 'the member ignore file, holding the one Langium artefact' },
   'langium-config.json': { verdict: 'identical', reason: 'one language, derived from --name' },
   'tsconfig.json': { verdict: 'identical', reason: 'the scaffold derives the extends and the pruned option set' },
   'tsconfig.test.json': { verdict: 'identical', reason: 'the scaffold emits isolatedModules too' },
   // Deliberately NOT switched to the repo's shared vitest helper, unlike
   // order-flow's: a provenance target that has been adapted pins nothing, and
   // this is the only target pinning the scaffold's own self-contained config.
   'vitest.config.ts': { verdict: 'identical', reason: "the scaffold's own config, kept rather than shared" },
   'README.md': { verdict: 'identical', reason: 'the scaffold README, with the example prose in examples/bookstore/README.md' },
   'src/grammar/bookstore.langium': { verdict: 'identical', reason: 'the starter grammar, which is what this example is' },
   'src/language-server/bookstore-module.ts': { verdict: 'identical', reason: 'the single-grammar composition, unmodified' },
   'src/language-server/ast.ts': { verdict: 'identical', reason: 'no AST augmentation — the framework defaults are the point' },
   'src/language-server/bookstore-serializer.ts': {
      verdict: 'identical',
      reason: 'the emitted concrete-syntax emitter for the starter grammar'
   },
   'src/index.ts': { verdict: 'identical', reason: 'the scaffolded public surface' },
   'src/services.ts': { verdict: 'identical', reason: 'the contract is language-count-agnostic' },
   'src/main.ts': { verdict: 'identical', reason: 'all three heads in one process, as emitted' },
   // The only in-repo target pinning this entry as EMITTED rather than adapted,
   // which is what makes it evidence that a scaffolded project can be reached by
   // `hydranium-cli query` / `save` / `projects` / `watch` with no hand edits.
   'src/data-server-main.ts': { verdict: 'identical', reason: 'the stdio data head the CLI subcommands spawn, as emitted' },
   'src/head-ports.ts': { verdict: 'identical', reason: 'both socket-head port commands, as emitted' },
   // The seven diagram files plus the starter operation handler. These are the
   // reason this target exists: nothing else in the repo executes them.
   'src/glsp/bookstore/types.ts': { verdict: 'identical', reason: 'the emitted diagram type ids' },
   'src/glsp/bookstore/state.ts': { verdict: 'identical', reason: 'the emitted full-text state' },
   'src/glsp/bookstore/storage.ts': { verdict: 'identical', reason: 'the emitted storage subclass' },
   'src/glsp/bookstore/submission-handler.ts': { verdict: 'identical', reason: 'the emitted submission handler' },
   'src/glsp/bookstore/gmodel-factory.ts': { verdict: 'identical', reason: 'the emitted AST→GModel walk' },
   'src/glsp/bookstore/diagram-configuration.ts': { verdict: 'identical', reason: 'the emitted type hints' },
   'src/glsp/bookstore/create-node-operation-handler.ts': { verdict: 'identical', reason: 'the emitted starter operation handler' },
   'src/glsp/bookstore/diagram-module.ts': { verdict: 'identical', reason: 'the emitted diagram DI wiring' },
   'test/services.test.ts': { verdict: 'identical', reason: 'the scaffolded composition test, which is the one this example needs' },
   // The only tier in this repo that runs a SCAFFOLDED serializer against a real
   // parse rather than a golden or a typecheck.
   'test/serialization.test.ts': { verdict: 'identical', reason: 'the scaffolded round-trip test, over the grammar it was emitted from' },
   // The three tiers `generator-langium` also scaffolds. Together with the two
   // above, this is the only place a SCAFFOLDED language is really parsed,
   // linked and validated rather than golden-compared or typechecked.
   'test/parsing.test.ts': { verdict: 'identical', reason: 'the scaffolded parse tier, over the starter rules' },
   'test/linking.test.ts': { verdict: 'identical', reason: 'the scaffolded link tier, including the cross-document half' },
   'test/validating.test.ts': {
      verdict: 'identical',
      reason: "the scaffolded validation tier, over the framework's own linker diagnostics"
   }
};

/**
 * The examples whose `init` provenance is checked, and the invocation each
 * records.
 *
 * `table` is the document a failure sends the reader to, and it is NOT always
 * the scaffolded package: bookstore's own README is the scaffold's, unedited
 * (that is the point of it), so its provenance table lives one directory up.
 * Naming it per target rather than deriving it from `dir` is what keeps the
 * failure message from pointing at a file with no table in it.
 */
const TARGETS = [
   {
      label: 'order-flow',
      dir: 'examples/order-flow/server',
      table: 'examples/order-flow/server/README.md',
      invocation: ORDER_FLOW_INVOCATION,
      manifest: ORDER_FLOW_MANIFEST
   },
   {
      label: 'bookstore',
      dir: 'examples/bookstore/server',
      table: 'examples/bookstore/README.md',
      invocation: BOOKSTORE_INVOCATION,
      manifest: BOOKSTORE_MANIFEST
   }
];

/**
 * The scaffold's text with an entry's exempted fields taken from the example,
 * the fields outside the exemption that disagree, and whatever is wrong with the
 * exemption itself.
 *
 * The overlay is what `--write` lays down; the field list is what the check
 * reports. **The remainder is compared per FIELD and not over the bytes**, which
 * an exempted `package.json` cannot be: prettier's packagejson plugin
 * canonicalises key order in this repo, so a byte-compare against the template's
 * emission order is unsatisfiable on a file both tools own. Key order is left to
 * the tool that enforces it and everything else stays here — a value that
 * changed, a field that vanished and a field nobody accounted for are all
 * reported.
 *
 * A field whose emitted spelling is not found exactly once is reported rather
 * than guessed at — silently failing to substitute would exempt the whole file
 * again, which is the state an `exempt` list exists to leave. That also bounds
 * the mechanism to fields the template spells on one line: an object value
 * stringifies to a form the pretty-printed emission does not contain, so it
 * fails loudly instead of matching a fragment of something else.
 */
function overlayExemptedFields(scaffoldContent, exampleContent, fields) {
   let scaffold;
   let example;
   try {
      scaffold = JSON.parse(scaffoldContent);
      example = JSON.parse(exampleContent);
   } catch (error) {
      return { problems: [`carries an exemption list, which only a JSON file can: ${error.message}`] };
   }
   const problems = [];
   let content = scaffoldContent;
   for (const field of fields) {
      if (scaffold[field] === undefined) {
         problems.push(`the manifest exempts '${field}' but the scaffold no longer emits it — drop it from the exemption.`);
         continue;
      }
      if (example[field] === undefined) {
         problems.push(`the manifest exempts '${field}' but the example has no such field.`);
         continue;
      }
      const emitted = `"${field}": ${JSON.stringify(scaffold[field])}`;
      const own = `"${field}": ${JSON.stringify(example[field])}`;
      if (emitted === own) {
         problems.push(`the manifest exempts '${field}' but it now matches the scaffold exactly — drop it from the exemption.`);
         continue;
      }
      if (content.split(emitted).length !== 2) {
         problems.push(`the manifest exempts '${field}', which the scaffold does not spell exactly once as \`${emitted}\`.`);
         continue;
      }
      content = content.replace(emitted, () => own);
   }
   // Named in the failure rather than left to the reader's diff: the whole
   // hazard an exemption carries is that it is read as covering more than it
   // says, and a message that only names the file it is on reads that way too.
   const union = new Set([...Object.keys(scaffold), ...Object.keys(example)]);
   const drifted = [...union].filter(
      field => !fields.includes(field) && JSON.stringify(scaffold[field]) !== JSON.stringify(example[field])
   );
   return { content, problems, drifted };
}

/**
 * Re-derive the files one target's manifest says are the scaffold's and write
 * them back, returning the paths written.
 *
 * **Keyed on the verdict, and that is the whole safety story.** An `adapted`
 * file is the example's own work — `order-flow`'s three real serializers sit at
 * paths the scaffold also emits — so a write mode that respected only the path
 * list would overwrite a hand-written language with a starter template and
 * report success. An `exempt` list is the one thing that makes an `adapted`
 * entry writable, because it says which fields the write must carry over; an
 * entry whose exemption cannot be applied is skipped rather than written
 * verbatim, since writing it would destroy the very field being exempted.
 *
 * The SPDX block is re-attached from the file being replaced rather than
 * synthesised: the examples do not share one copyright line, so generating it
 * would silently rewrite attribution. A file that carries no header keeps none.
 */
function writeTarget(init, target) {
   const exampleDir = join(REPO_ROOT, target.dir);
   const { files } = deriveScaffold(init, target);
   const written = [];
   for (const file of files) {
      const entry = target.manifest[file.path];
      const exempt = entry?.verdict === 'adapted' ? entry.exempt : undefined;
      if (entry?.verdict !== 'identical' && exempt === undefined) {
         continue;
      }
      const absolute = join(exampleDir, file.path);
      const existing = existsSync(absolute) ? splitShebang(readFileSync(absolute, 'utf-8')).body.split('\n') : undefined;
      const header = existing?.[0]?.startsWith('/****') ? existing.slice(0, HEADER_LINES).join('\n') + '\n' : '';
      let content = file.content;
      if (exempt !== undefined) {
         const example = readExample(exampleDir, file.path);
         const overlay = example === undefined ? undefined : overlayExemptedFields(file.content, example, exempt);
         if (overlay === undefined || overlay.problems.length > 0) {
            continue;
         }
         content = overlay.content;
      }
      // The shebang comes off the CONTENT and goes back above the header, which
      // is the order the interpreter and a licence sweep both require; writing
      // `header + content` would bury it on line 10 and leave the linked binary
      // being read by the shell.
      const emitted = splitShebang(content);
      writeFileSync(absolute, emitted.shebang + header + emitted.body);
      written.push(file.path);
   }
   return written;
}

/**
 * Read an example file, dropping the SPDX header the scaffold does not emit.
 *
 * Line endings are normalised because the comparison is byte-exact against a
 * template that emits `\n`. A checkout with `core.autocrlf=true` — the
 * Git-for-Windows default — materialises every tracked file with CRLF, which
 * would make this gate report content drift on essentially every file while the
 * content is in fact identical.
 */
function readExample(exampleDir, relativePath) {
   const absolute = join(exampleDir, relativePath);
   if (!existsSync(absolute)) {
      return undefined;
   }
   const { shebang, body } = splitShebang(readFileSync(absolute, 'utf-8').replace(/\r\n/g, '\n'));
   const lines = body.split('\n');
   return shebang + (lines[0]?.startsWith('/****') ? lines.slice(HEADER_LINES) : lines).join('\n');
}

function checkEntry(exampleDir, file, entry, problems) {
   const { path, content } = file;
   const example = readExample(exampleDir, path);
   if (entry.exempt !== undefined && entry.verdict !== 'adapted') {
      problems.push({ text: `${path}: an exemption list narrows an 'adapted' verdict and is inert on '${entry.verdict}'.` });
   }
   switch (entry.verdict) {
      case 'identical':
         if (example === undefined) {
            problems.push({ text: `${path}: manifest says 'identical' but the example has no such file.`, writable: true });
         } else if (example !== content) {
            problems.push({
               text: `${path}: manifest says 'identical' but it differs from the scaffold. Either re-derive it from the template, or reclassify it as 'adapted' and record why.`,
               writable: true
            });
         }
         return;
      case 'adapted': {
         if (example === undefined) {
            problems.push({ text: `${path}: manifest says 'adapted' but the example has no such file.` });
            return;
         }
         if (entry.exempt === undefined) {
            if (example === content) {
               problems.push({
                  text: `${path}: manifest says 'adapted' but it now matches the scaffold exactly — reclassify it as 'identical'.`
               });
            }
            return;
         }
         const overlay = overlayExemptedFields(content, example, entry.exempt);
         overlay.problems.forEach(problem => problems.push({ text: `${path}: ${problem}` }));
         if (overlay.problems.length === 0 && overlay.drifted.length > 0) {
            const where = overlay.drifted.map(field => `'${field}'`).join(', ');
            problems.push({
               text: `${path}: the manifest exempts ${entry.exempt.join(', ')}, but it also differs from the scaffold in ${where}. Either re-derive it, or widen the exemption and record what the example now owns.`,
               writable: true
            });
         }
         return;
      }
      case 'replaced':
         if (example !== undefined) {
            problems.push({ text: `${path}: manifest says 'replaced' by ${entry.by}, but the scaffolded path still exists.` });
         } else if (!existsSync(join(exampleDir, entry.by))) {
            problems.push({ text: `${path}: manifest says 'replaced' by ${entry.by}, which does not exist.` });
         }
         return;
      case 'dropped':
         if (example !== undefined) {
            problems.push({ text: `${path}: manifest says 'dropped' but the example still has it.` });
         }
         return;
      default:
         problems.push({ text: `${path}: unknown verdict '${entry.verdict}' in the manifest.` });
   }
}

/**
 * Re-derive one target's scaffold. Shared by the check and the write, so the
 * bytes `--write` lays down are the ones the check then compares — deriving them
 * twice is how a write mode drifts from the gate that judges it.
 *
 * Resolved through `init`'s own helpers, rooted at the example's real directory,
 * so it sees exactly the composition `runInit` would. Every packaging flag is
 * forwarded, including ones no target records yet: a recorded `scope` that this
 * call dropped would be compared against an unscoped scaffold and reported as a
 * package-name adaptation nobody made.
 */
function deriveScaffold(init, target) {
   const { invocation } = target;
   const packaging = init.resolveInitPackaging(join(REPO_ROOT, target.dir), {
      monorepo: invocation.monorepo,
      public: invocation.public,
      scope: invocation.scope
   });
   return {
      files: init.planInitFiles(init.resolveInitComposition(invocation.name, invocation.grammars, invocation.heads, packaging))
   };
}

/** Re-derive one target's scaffold and compare it against the manifest. Returns the problems found. */
function checkTarget(init, target) {
   const exampleDir = join(REPO_ROOT, target.dir);
   const { manifest } = target;
   const { files } = deriveScaffold(init, target);

   const problems = [];
   const emitted = new Set(files.map(file => file.path));
   for (const path of Object.keys(manifest)) {
      if (!emitted.has(path)) {
         problems.push({ text: `${path}: in the manifest but no longer emitted by init — drop the entry.` });
      }
   }
   for (const file of files) {
      const entry = manifest[file.path];
      if (!entry) {
         problems.push({
            text: `${file.path}: emitted by init but absent from the manifest. Decide what the example does with it and record the verdict.`
         });
         continue;
      }
      checkEntry(exampleDir, file, entry, problems);
   }
   return { problems, count: files.length };
}

/**
 * Where each version literal the scaffold emits is allowed to come from.
 *
 * `init` derives its `@hydranium/*` pins from its own manifest, so those cannot
 * drift. Everything else in the emitted `package.json` is a literal somebody
 * types, and the framework pins the same packages elsewhere — root `overrides`
 * for the atomic langium chain, the head packages' own manifests for what they
 * are built against. Nothing tied the two together, so bumping the chain left
 * every future scaffold behind, and a scaffolded project pinning a different
 * `langium` than the framework was built against resolves a SECOND physical copy
 * — the identity failure the `overrides` block exists to prevent, needing no
 * adopter action to trigger.
 *
 * It is checkable from inside the repository because both sides are tracked
 * files, which is what makes it worth a gate at all: the analogous npm-scope and
 * bin-symlink hazards need a vantage point outside the repo and get none.
 *
 * Four rules, because the scaffold does not always spell a pin the way the
 * source manifest does:
 * - `exact` — the emitted literal equals the source literal.
 * - `tilde` — the emitted literal is the source version with a `~` in front.
 * - `minor` — only major.minor must agree, for a package released on its own
 *   patch line against a given minor of another.
 * - `admits` — the emitted RANGE resolves the source version, for a dependency
 *   the scaffold ranges deliberately because a third party's peer requirement
 *   sets its floor. The other three are literal-equality shaped and cannot
 *   express that: they would force the scaffold to emit the framework's exact
 *   version and so narrow a range an adopter is meant to be able to satisfy
 *   with any compatible copy. What still has to hold is that the version the
 *   framework compiles against is INSIDE the range a scaffolded project would
 *   resolve from, which is the identity hazard this table exists for.
 *
 * `unpinned` records a deliberate absence with its reason, so that a dependency
 * with no framework counterpart is a decision rather than an omission. Every
 * emitted non-`@hydranium/*` dependency must appear here, or the check fails:
 * a table that silently stops covering a new template literal is the exact
 * failure this exists to prevent, one level up.
 */
const SCAFFOLD_PIN_SOURCES = {
   langium: { file: 'package.json', path: ['overrides', 'langium'], rule: 'exact' },
   // The chain moves as one, but `langium-cli` ships its own patch line against
   // a given langium minor, so the minor is the part that has to agree.
   'langium-cli': { file: 'package.json', path: ['overrides', 'langium'], rule: 'minor' },
   'vscode-languageserver': { file: 'packages/cli/package.json', path: ['devDependencies', 'vscode-languageserver'], rule: 'exact' },
   '@eclipse-glsp/server': { file: 'packages/glsp-server/package.json', path: ['devDependencies', '@eclipse-glsp/server'], rule: 'exact' },
   // `graph` has no declaration of its own anywhere in `packages/` — it reaches
   // the framework as a transitive of `server` — and the GLSP packages ship as
   // one release line, so `server` is the version it has to track.
   '@eclipse-glsp/graph': { file: 'packages/glsp-server/package.json', path: ['devDependencies', '@eclipse-glsp/server'], rule: 'exact' },
   'reflect-metadata': { file: 'packages/glsp-server/package.json', path: ['devDependencies', 'reflect-metadata'], rule: 'tilde' },
   // Ranged rather than pinned on purpose: `@eclipse-glsp/server` sets the floor
   // through its own peer requirement, so a scaffold pinning the framework's
   // exact version would refuse copies GLSP accepts. `admits` is what relates
   // the two without moving either.
   inversify: { file: 'packages/glsp-server/package.json', path: ['devDependencies', 'inversify'], rule: 'admits' },
   '@types/node': { file: 'package.json', path: ['devDependencies', '@types/node'], rule: 'exact' },
   rimraf: { file: 'package.json', path: ['devDependencies', 'rimraf'], rule: 'exact' },
   typescript: { file: 'package.json', path: ['devDependencies', 'typescript'], rule: 'exact' },
   vitest: { file: 'package.json', path: ['devDependencies', 'vitest'], rule: 'exact' }
};

/** Strip a range operator, then keep `major.minor`. */
function majorMinor(version) {
   const parts = version.replace(/^[~^><= ]+/, '').split('.');
   return `${parts[0]}.${parts[1]}`;
}

/** `[major, minor, patch]` for a bare `x.y.z`, or `undefined` for anything else. */
function parseVersion(text) {
   const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
   return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Lexicographic compare of two `[major, minor, patch]` triples. */
function compareVersions(left, right) {
   for (let i = 0; i < 3; i++) {
      if (left[i] !== right[i]) {
         return left[i] < right[i] ? -1 : 1;
      }
   }
   return 0;
}

/**
 * Whether `range` resolves `version` — `{ agrees }`, or `{ why }` when the range
 * is a form this cannot decide.
 *
 * **Hand-rolled, and deliberately narrow rather than complete.** `semver` is
 * present in `node_modules` only as somebody else's transitive, and no
 * `scripts/` tool may depend on one: declaring it means regenerating the
 * lockfile, and importing it undeclared makes this gate fail on the day that
 * transitive moves. So the three operators the scaffold can emit are
 * implemented, and every other form is REFUSED by name.
 *
 * The refusal is the load-bearing half. A permissive fallback — treat what you
 * cannot parse as agreeing — would grade an operator nobody implemented as
 * satisfied, which is indistinguishable from the drift the rule exists to
 * catch, and a range is the one pin shape where "agrees" is the overwhelmingly
 * common answer.
 *
 * A prerelease on either side is refused rather than ordered: prerelease
 * precedence is where a hand-rolled comparison silently disagrees with npm's,
 * and the scaffold emits none.
 */
function admits(range, version) {
   const target = parseVersion(version);
   if (target === undefined) {
      return { why: `'${version}' is not a bare major.minor.patch version, so no range can be checked against it` };
   }
   const operator = /^[~^]/.exec(range);
   const floor = parseVersion(range.slice(operator === null ? 0 : 1));
   if (floor === undefined) {
      return { why: `'${range}' is not an exact version, a caret range or a tilde range, which are the only forms this gate decides` };
   }
   if (compareVersions(target, floor) < 0) {
      return { agrees: false };
   }
   if (operator === null) {
      return { agrees: compareVersions(target, floor) === 0 };
   }
   // `^0.y.z` allows patches only, and `^0.0.z` nothing at all — npm's caret
   // treats a zero major as unstable, so the width depends on the floor rather
   // than on the operator alone.
   const caretWidens = operator[0] === '^' && floor[0] > 0;
   const ceiling = caretWidens ? [floor[0] + 1, 0, 0] : [floor[0], floor[1] + 1, 0];
   const zeroMinorCaret = operator[0] === '^' && floor[0] === 0 && floor[1] === 0;
   return { agrees: compareVersions(target, zeroMinorCaret ? [0, 0, floor[2] + 1] : ceiling) < 0 };
}

/**
 * Whether one emitted pin agrees with its recorded source, by the entry's rule.
 *
 * Split out of {@link comparePins} because `admits` is the first rule that can
 * fail for a THIRD reason — the range is a form the gate does not decide — and
 * a boolean cannot carry that apart from disagreement.
 */
function pinAgrees(rule, pin, declared) {
   switch (rule) {
      case 'exact':
         return { agrees: pin === declared };
      case 'tilde':
         return { agrees: pin === `~${declared}` };
      case 'minor':
         return { agrees: majorMinor(pin) === majorMinor(declared) };
      case 'admits':
         return admits(pin, declared);
      default:
         return { why: `its recorded rule '${rule}' is not one this gate implements` };
   }
}

/** The version each pin source currently declares, keyed by the dependency the scaffold emits. */
function readPinSources() {
   const resolved = {};
   for (const [dependency, source] of Object.entries(SCAFFOLD_PIN_SOURCES)) {
      if (source.unpinned !== undefined) {
         continue;
      }
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, source.file), 'utf-8'));
      resolved[dependency] = source.path.reduce((value, key) => (value === undefined ? undefined : value[key]), manifest);
   }
   return resolved;
}

/**
 * Compare the versions a scaffold emits against the ones the repo declares.
 *
 * Pure over both inputs so the self-test can drive it with a fabricated
 * emission; the real call reads one from `init` and the other from disk.
 */
function comparePins(emitted, sources) {
   const problems = [];
   for (const [dependency, pin] of Object.entries(emitted)) {
      if (dependency.startsWith('@hydranium/')) {
         continue;
      }
      const source = SCAFFOLD_PIN_SOURCES[dependency];
      if (source === undefined) {
         problems.push(
            `${dependency}: the scaffold pins '${pin}' but nothing records where that version comes from. Add it to SCAFFOLD_PIN_SOURCES, or record why it is unpinned.`
         );
         continue;
      }
      if (source.unpinned !== undefined) {
         continue;
      }
      const declared = sources[dependency];
      if (declared === undefined) {
         problems.push(`${dependency}: its recorded source ${source.file} no longer declares ${source.path.join('.')}.`);
         continue;
      }
      const { agrees, why } = pinAgrees(source.rule, pin, declared);
      if (why !== undefined) {
         problems.push(`${dependency}: the scaffold pins '${pin}' and ${source.file} declares '${declared}', but ${why}.`);
      } else if (!agrees) {
         problems.push(
            source.rule === 'admits'
               ? `${dependency}: the scaffold ranges '${pin}' but ${source.file} declares '${declared}', which that range does not admit. A scaffolded project could not resolve the copy the framework was built against.`
               : `${dependency}: the scaffold pins '${pin}' but ${source.file} declares '${declared}'. A scaffolded project would resolve a different copy than the framework was built against.`
         );
      }
   }
   for (const dependency of Object.keys(SCAFFOLD_PIN_SOURCES)) {
      if (emitted[dependency] === undefined) {
         problems.push(`${dependency}: recorded in SCAFFOLD_PIN_SOURCES but the scaffold no longer emits it — drop the entry.`);
      }
   }
   return problems;
}

/** Every version the scaffold emits, at the head set that carries all of them. */
function emittedPins(init) {
   const composition = init.resolveInitComposition('PinProbe', undefined, ['lsp', 'data', 'glsp']);
   const content = init.planInitFiles(composition).find(file => file.path === 'package.json')?.content;
   if (content === undefined) {
      throw new Error('the scaffold emitted no package.json, so its pins cannot be checked');
   }
   const manifest = JSON.parse(content);
   return { ...manifest.dependencies, ...manifest.devDependencies };
}

/**
 * Prove {@link comparePins} still discriminates, on every run.
 *
 * Same bargain as the `--write` self-test below it: a rule nobody exercises can
 * stop firing without anything going red, and a pin gate that has stopped firing
 * reports universal agreement — which is indistinguishable from the state it
 * exists to detect. Two canaries, one per direction the table can rot: a literal
 * that has drifted from its source, and a literal that has no source at all.
 *
 * The `admits` rule needs three of its own, because it is the one rule whose
 * PASS is the common case by construction — a caret range admits almost every
 * version its source could declare — so a green says nothing about whether the
 * rule discriminates. What separates a working range check from one that matches
 * nothing is a source version the range must REFUSE, a range form the rule must
 * refuse to decide, and the agreeing case below proving it does not just report
 * everything.
 */
function selfTestPinComparison(sources) {
   const failures = [];
   const drifted = { langium: '9.9.9' };
   if (!comparePins(drifted, sources).some(problem => problem.startsWith('langium:'))) {
      failures.push('a langium pin drifted to 9.9.9 was not reported — the comparison no longer discriminates');
   }
   const unrecorded = { 'some-package-nobody-declared': '1.0.0' };
   if (!comparePins(unrecorded, sources).some(problem => problem.startsWith('some-package-nobody-declared:'))) {
      failures.push('an emitted dependency with no recorded source was not reported — a new template literal would slip through');
   }
   if (!comparePins({}, sources).some(problem => problem.startsWith('langium:'))) {
      failures.push('an emission that dropped langium entirely was not reported — the stale-entry direction is inert');
   }
   // The inverse of all three, and the one that makes them mean something: a
   // comparison that reported unconditionally would satisfy every canary above
   // while proving nothing about a scaffold that actually agrees.
   const agreeing = { ...sources, 'reflect-metadata': `~${sources['reflect-metadata']}`, inversify: '^6.1.3' };
   const spurious = comparePins(agreeing, sources);
   if (spurious.length > 0) {
      failures.push(`an emission that agrees with every source was reported anyway: ${spurious.join('; ')}`);
   }

   const outsideRange = { ...sources, inversify: '7.0.0' };
   if (!comparePins(agreeing, outsideRange).some(problem => problem.startsWith('inversify:'))) {
      failures.push("a source version outside the range the scaffold emits was not reported — the 'admits' rule matches everything");
   }
   const belowFloor = { ...sources, inversify: '6.0.0' };
   if (!comparePins(agreeing, belowFloor).some(problem => problem.startsWith('inversify:'))) {
      failures.push("a source version below the range's floor was not reported — 'admits' only checks the upper bound");
   }
   const undecidable = comparePins({ ...agreeing, inversify: '>=6 <7' }, sources);
   if (!undecidable.some(problem => problem.startsWith('inversify:'))) {
      failures.push("a range form 'admits' cannot decide was not reported — an unimplemented operator grades as agreeing");
   }
   return failures;
}

/**
 * Prove `--write` still respects the manifest before trusting it with an
 * example, on every run.
 *
 * **Why a self-test and not a unit suite:** the failure this guards is SILENT
 * and destructive — a write that stopped keying on the verdict would overwrite
 * `order-flow`'s hand-written serializers, which sit at paths the scaffold also
 * emits, and print a success line while doing it. `scripts/` has no test tier,
 * and a gate whose dangerous half is only ever exercised by hand is one refactor
 * from being wrong in a way nobody sees. `check:neutral`'s canaries are the same
 * bargain.
 *
 * Five behaviours, which are exactly the five `writeTarget` decides: an
 * `identical` entry is rewritten, a bare `adapted` entry is NOT, an `adapted`
 * entry with an exemption IS but keeps the exempted field, an existing SPDX
 * block survives the rewrite, and an emitted shebang lands ABOVE that block and
 * reads back off it. The fixture is a throwaway directory holding a sentinel per
 * path — nothing is copied and no example is touched.
 *
 * The shebang pair is checked in both directions on purpose: a write that buried
 * it under the header and a read that failed to strip the header beneath it
 * produce the same symptom on a real target — a `bin` entry graded as drifted —
 * and only the round trip distinguishes which half is wrong.
 */
function selfTestWriteRestriction(init) {
   const relativeDir = join('node_modules', '.init-provenance-selftest');
   const dir = join(REPO_ROOT, relativeDir);
   const SENTINEL = '// SELF-TEST SENTINEL — must survive on an `adapted` entry.\n';
   // Parseable, because the same fixture path stands in for both the bare
   // `adapted` entry and the exempted one, and only the second reads it as JSON.
   const JSON_SENTINEL = '{\n  "name": "self-test-sentinel"\n}\n';
   const header = `${'/'}${'*'.repeat(79)}\n * Copyright (c) 2026 Self Test\n *\n * SPDX-License-Identifier: MIT\n${' '.repeat(1)}${'*'.repeat(79)}${'/'}\n`;
   // The header block the gate strips is 8 lines plus a blank one; pad to that
   // exact shape so the fixture exercises the real slice rather than a near-miss.
   const paddedHeader = header.split('\n').slice(0, 5).concat([' *', ' *', ' */', '']).join('\n');

   const identicalPath = join('src', 'language-server', 'bookstore-serializer.ts');
   const headeredPath = join('src', 'language-server', 'ast.ts');
   // The emitted `bin` entry, which is the one file that carries a shebang.
   const shebangPath = join('src', 'main.ts');
   const adaptedPath = 'package.json';

   rmSync(dir, { recursive: true, force: true });
   mkdirSync(join(dir, 'src', 'language-server'), { recursive: true });
   writeFileSync(join(dir, identicalPath), SENTINEL);
   writeFileSync(join(dir, headeredPath), paddedHeader + SENTINEL);
   writeFileSync(join(dir, shebangPath), paddedHeader + SENTINEL);
   writeFileSync(join(dir, adaptedPath), JSON_SENTINEL);

   const manifest = {
      [identicalPath.split('\\').join('/')]: { verdict: 'identical' },
      [headeredPath.split('\\').join('/')]: { verdict: 'identical' },
      [shebangPath.split('\\').join('/')]: { verdict: 'identical' },
      [adaptedPath]: { verdict: 'adapted' }
   };
   const target = { label: 'self-test', dir: relativeDir, invocation: BOOKSTORE_INVOCATION, manifest };

   const failures = [];
   try {
      const written = writeTarget(init, target).sort();
      const expected = [headeredPath, identicalPath, shebangPath].map(path => path.split('\\').join('/')).sort();
      if (written.join() !== expected.join()) {
         failures.push(`wrote [${written.join(', ')}], expected exactly the two 'identical' entries`);
      }
      if (readFileSync(join(dir, adaptedPath), 'utf-8') !== JSON_SENTINEL) {
         failures.push("a bare 'adapted' entry was overwritten — the write is keyed on the path list, not the verdict");
      }
      if (readFileSync(join(dir, identicalPath), 'utf-8') === SENTINEL) {
         failures.push("an 'identical' entry was left unwritten — the write is inert");
      }
      if (!readFileSync(join(dir, headeredPath), 'utf-8').startsWith(paddedHeader)) {
         failures.push('the SPDX block did not survive a rewrite — re-syncing would strip every example header');
      }

      const rewrittenBin = readFileSync(join(dir, shebangPath), 'utf-8');
      const emittedBin = deriveScaffold(init, target).files.find(file => file.path === shebangPath.split('\\').join('/'))?.content ?? '';
      if (!emittedBin.startsWith('#!')) {
         failures.push(`the scaffold no longer emits a shebang on ${shebangPath} — this pair of canaries now proves nothing`);
      } else if (!rewrittenBin.startsWith(emittedBin.split('\n')[0] + '\n' + paddedHeader)) {
         failures.push('the shebang did not land above the SPDX block — a re-derived bin entry would be read by the shell, not by node');
      } else if (readExample(dir, shebangPath.split('\\').join('/')) !== emittedBin) {
         failures.push('a shebang-first file did not read back as the scaffold emitted it — the header below it is not being stripped');
      }

      manifest[adaptedPath] = { verdict: 'adapted', exempt: ['name'] };
      const rewritten = writeTarget(init, target);
      if (!rewritten.includes(adaptedPath)) {
         failures.push("an exempted 'adapted' entry was skipped — the exemption cannot re-derive the file it narrows");
      }
      const exempted = JSON.parse(readFileSync(join(dir, adaptedPath), 'utf-8'));
      if (exempted.name !== 'self-test-sentinel') {
         failures.push(`the exempted field was overwritten with '${exempted.name}' — the write does not carry it over`);
      }
      if (exempted.scripts === undefined) {
         failures.push('the scaffold body did not land beside the exempted field — the write left the example as it was');
      }
   } finally {
      rmSync(dir, { recursive: true, force: true });
   }
   return failures;
}

/**
 * Prove the exemption still narrows rather than waives, on every run.
 *
 * Same bargain as the pin canaries: an exemption that stopped reporting the
 * remainder would grade a file nobody checks, which is indistinguishable from
 * the outside from the blanket verdict it replaced — and an exemption that
 * reported its own field would delete the adaptation rather than narrow it. Both
 * directions, plus the two ways the field list itself goes stale. Pure over
 * fabricated JSON so no example is involved.
 */
function selfTestFieldExemption() {
   const scaffold = '{\n  "name": "scaffolded",\n  "license": "UNLICENSED"\n}\n';
   const failures = [];

   const drifted = '{\n  "name": "adopted",\n  "license": "MIT"\n}\n';
   const reported = overlayExemptedFields(scaffold, drifted, ['name']);
   if (!reported.drifted.includes('license')) {
      failures.push('a field outside the exemption differed and was not reported — the exemption still waives the file');
   }
   if (reported.content === drifted) {
      failures.push('the overlay absorbed a field outside the exemption — a write would keep the drift it just reported');
   }
   const agreeing = '{\n  "name": "adopted",\n  "license": "UNLICENSED"\n}\n';
   const clean = overlayExemptedFields(scaffold, agreeing, ['name']);
   if (clean.problems.length > 0 || clean.drifted.length > 0 || clean.content !== agreeing) {
      failures.push(
         `an example differing only in its exempted field was reported anyway: ${[...clean.problems, ...clean.drifted].join('; ')}`
      );
   }
   const stale = overlayExemptedFields(scaffold, scaffold, ['name']);
   if (!stale.problems.some(problem => problem.includes("'name'"))) {
      failures.push('an exempted field that matches the scaffold was not reported — a stale exemption is invisible');
   }
   const missing = overlayExemptedFields(scaffold, agreeing, ['nothing-emits-this']);
   if (missing.problems.length === 0) {
      failures.push('an exemption naming a field the scaffold does not emit was not reported');
   }
   return failures;
}

async function main() {
   // A file URL, not the bare path: the ESM loader reads an absolute Windows
   // path as a URL whose scheme is the drive letter, and refuses `d:` outright.
   // A POSIX path happens to parse as a path-only URL, so this works unconverted
   // on one platform and throws on the other before the script does anything.
   const init = await import(pathToFileURL(join(REPO_ROOT, 'packages/cli/lib/commands/init.js')).href);
   const write = process.argv.slice(2).includes('--write');

   // Ahead of the write self-test, which exercises the same overlay through a
   // fixture: a canary that touches no disk attributes the fault to the
   // comparison itself, and whichever banner fires first is the one read.
   const exemptionFailures = selfTestFieldExemption();
   if (exemptionFailures.length > 0) {
      console.error("✗ the field-exemption self-test failed, so this run can say nothing about the 'adapted' files:\n");
      exemptionFailures.forEach(failure => console.error(`  - ${failure}`));
      process.exit(2);
   }

   // Before either mode, and before `--write` is allowed near an example.
   const selfTestFailures = selfTestWriteRestriction(init);
   if (selfTestFailures.length > 0) {
      console.error('✗ the --write self-test failed, so this run can say nothing about the examples:\n');
      selfTestFailures.forEach(failure => console.error(`  - ${failure}`));
      process.exit(2);
   }

   const pinSources = readPinSources();
   const pinSelfTestFailures = selfTestPinComparison(pinSources);
   if (pinSelfTestFailures.length > 0) {
      console.error('✗ the scaffold-pin self-test failed, so this run can say nothing about the emitted versions:\n');
      pinSelfTestFailures.forEach(failure => console.error(`  - ${failure}`));
      process.exit(2);
   }

   if (write) {
      for (const target of TARGETS) {
         const written = writeTarget(init, target);
         console.log(`✓ re-derived ${written.length} scaffolded file(s) in ${target.label}`);
      }
      // Deliberately not followed by a check run: the write reaches only the
      // files the manifest says are the scaffold's, so it cannot answer the
      // problems the other verdicts raise, and printing a green verdict here
      // would claim it had.
      console.log(
         '\nRun the formatter over what changed, then run without --write to verify, and review the diff — an `adapted` file with no exemption is untouched by design.'
      );
      process.exit(0);
   }

   let failed = false;

   // Run before the targets, because a pin that has drifted is a template defect
   // rather than an example one and every target would otherwise report it as
   // its own package.json drifting.
   const pinProblems = comparePins(emittedPins(init), pinSources);
   if (pinProblems.length > 0) {
      failed = true;
      console.error('✗ the versions `init` scaffolds no longer match the ones this repo declares:\n');
      pinProblems.forEach(problem => console.error(`  - ${problem}`));
      console.error('\nEdit the literal in packages/cli/src/commands/init-templates.ts, or move its recorded source in this script.\n');
   } else {
      console.log(
         `✓ all ${Object.keys(SCAFFOLD_PIN_SOURCES).length} scaffolded third-party versions match the manifests that declare them`
      );
   }

   for (const target of TARGETS) {
      // Per target, so a throw in one is attributed and the rest still run — an
      // unlabelled stack trace over two targets says nothing about which broke.
      let outcome;
      try {
         outcome = checkTarget(init, target);
      } catch (error) {
         failed = true;
         console.error(
            `✗ ${target.label}: re-deriving the scaffold threw — the recorded invocation may no longer be one \`init\` accepts.`
         );
         console.error(error);
         continue;
      }
      const { problems, count } = outcome;
      if (problems.length > 0) {
         failed = true;
         console.error(`✗ ${target.label} no longer matches its documented \`init\` provenance:\n`);
         for (const problem of problems) {
            console.error(`  - ${problem.text}`);
         }
         console.error(
            `\nThe manifest in scripts/check-init-provenance.mjs is what this gate reads. The prose table in ${target.table} is not, so it takes a hand edit to keep it true.`
         );
         // Pointed at only for the problems it can actually fix, and flagged at
         // the push site rather than sniffed out of the message: an 'adapted'
         // problem is writable only where the entry names the fields the write
         // has to carry over, so matching on the text would offer the write for
         // the blanket exemption it must never be offered for.
         if (problems.some(problem => problem.writable)) {
            console.error('Where a file only drifted from the scaffold, `node scripts/check-init-provenance.mjs --write` re-derives it.');
         }
         console.error('');
      } else {
         console.log(`✓ all ${count} scaffolded files match their documented provenance in ${target.label}`);
      }
   }
   if (failed) {
      process.exit(1);
   }
}

main().catch(error => {
   console.error(error);
   process.exit(2);
});
