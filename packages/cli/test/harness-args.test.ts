/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The argv machinery the subcommands share.
 *
 * Reachable at all only because it lives beside the commands rather than in the
 * entry point, which runs `main()` on import — importing that to reach a parser
 * runs the binary, which leaves a spawned process as the only way to observe any
 * of this.
 *
 * The messages are asserted verbatim, not by shape. They are the surface a
 * script greps, so "reports something" is not the property — "reports exactly
 * this" is.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
   assertRequired,
   exitWithUsage,
   helpRequested,
   numericOption,
   parseFlagOptions,
   parseHarnessArgs,
   parseServerSpawnOptions,
   resolveWorkspaceArgument
} from '../src/commands/harness-args.js';

/** Report usage problems as throws, so a failure is visible instead of ending the worker. */
function onError(message: string): never {
   throw new Error(message);
}

/**
 * A directory that exists for as long as the suite runs. This file's own
 * directory rather than a created fixture, so the value the workspace check
 * accepts cannot go missing underneath the assertions that need it.
 */
const EXISTING_DIR = path.dirname(fileURLToPath(import.meta.url));

/** A path under {@link EXISTING_DIR} that nothing in the tree creates. */
const MISSING_DIR = path.join(EXISTING_DIR, 'no-such-workspace-dir');

describe('parseHarnessArgs', () => {
   it('claims --services, the workspace positional, and the declared value and bool flags', () => {
      const parsed = parseHarnessArgs(
         ['--services', './services.js', '--out', 'report.json', EXISTING_DIR, '--strict'],
         'cmd-one',
         ['--out'],
         ['--strict'],
         { onError }
      );

      expect(parsed.servicesModule).toBe('./services.js');
      expect(parsed.workspace).toBe(EXISTING_DIR);
      expect(parsed.options['--out']).toBe('report.json');
      // A bool flag records its presence as the string 'true' — the callers
      // compare against it rather than coercing, so the value is load-bearing.
      expect(parsed.options['--strict']).toBe('true');
   });

   it('collects a repeatable value flag in order, and leaves it absent when unused', () => {
      const repeated = parseHarnessArgs(['--services', 'M', '--prop', 'alpha', '--prop', 'beta'], 'cmd-one', [], [], {
         requireWorkspace: false,
         repeatableValueFlags: ['--prop'],
         onError
      });
      expect(repeated.values['--prop']).toEqual(['alpha', 'beta']);

      const unused = parseHarnessArgs(['--services', 'M'], 'cmd-one', [], [], {
         requireWorkspace: false,
         repeatableValueFlags: ['--prop'],
         onError
      });
      // Absent, not empty: a caller forwards this straight through, and `[]`
      // would read as "the user asked for no properties".
      expect(unused.values['--prop']).toBeUndefined();
   });

   it('rejects a positional when the subcommand takes no workspace', () => {
      expect(() => parseHarnessArgs(['--services', 'M', '/ws'], 'cmd-two', [], [], { requireWorkspace: false, onError })).toThrow(
         'Unexpected argument: /ws (hydranium-cli cmd-two --help)'
      );
      expect(parseHarnessArgs(['--services', 'M'], 'cmd-two', [], [], { requireWorkspace: false, onError }).workspace).toBe('');
   });

   it('rejects a second positional when the subcommand takes one workspace', () => {
      expect(() => parseHarnessArgs(['--services', 'M', '/ws', '/other'], 'cmd-one', [], [], { onError })).toThrow(
         'Unexpected argument: /other (hydranium-cli cmd-one --help)'
      );
   });

   it('names the subcommand and its help in the unknown-option message', () => {
      expect(() => parseHarnessArgs(['--services', 'M', '/ws', '--nope'], 'cmd-one', [], [], { onError })).toThrow(
         'Unknown option: --nope (hydranium-cli cmd-one --help)'
      );
   });

   it('reports a value flag left without its value', () => {
      expect(() => parseHarnessArgs(['--services', 'M', '/ws', '--out'], 'cmd-one', ['--out'], [], { onError })).toThrow(
         'Missing value for --out'
      );
      expect(() => parseHarnessArgs(['--services'], 'cmd-one', [], [], { onError })).toThrow('Missing value for --services');
   });

   it('demands --services and the workspace', () => {
      expect(() => parseHarnessArgs(['/ws'], 'cmd-one', [], [], { onError })).toThrow(
         'Missing required option: --services (hydranium-cli cmd-one --help)'
      );
      expect(() => parseHarnessArgs(['--services', 'M'], 'cmd-one', [], [], { onError })).toThrow(
         'Missing required option: <workspace> (hydranium-cli cmd-one --help)'
      );
   });

   it('refuses a workspace that reaches no directory, so the check cannot be per-subcommand', () => {
      // Asserted through the shared parser, not through a command: every
      // workspace-taking subcommand inherits the check from here, and one that
      // acquired its own copy could drift from this message.
      expect(() => parseHarnessArgs(['--services', 'M', MISSING_DIR], 'cmd-one', [], [], { onError })).toThrow(
         `<workspace> does not exist: '${MISSING_DIR}'`
      );
   });

   it('leaves the workspace empty for a subcommand that takes none, rather than resolving it', () => {
      // `path.resolve('')` is the cwd, which exists — so a check applied to the
      // `''` of a workspace-free subcommand would pass and hand it the cwd as a
      // workspace it never asked for.
      expect(parseHarnessArgs(['--services', 'M'], 'cmd-two', [], [], { requireWorkspace: false, onError }).workspace).toBe('');
   });
});

describe('resolveWorkspaceArgument', () => {
   const scratch = mkdtempSync(path.join(tmpdir(), 'hydranium-harness-args-'));
   afterAll(() => rmSync(scratch, { recursive: true, force: true }));

   it('returns an existing directory as an absolute path', () => {
      expect(resolveWorkspaceArgument(EXISTING_DIR, 'cmd-one', onError)).toBe(EXISTING_DIR);
      // Un-normalized on purpose: the driver argv carries this value across a
      // process boundary, so it has to be a path the child can use as given.
      expect(resolveWorkspaceArgument(`${EXISTING_DIR}/../${path.basename(EXISTING_DIR)}`, 'cmd-one', onError)).toBe(EXISTING_DIR);
   });

   it('names both the argument and what it resolved to, so a relative path is debuggable', () => {
      // The resolved form is the load-bearing half: a rotted RELATIVE path in a
      // CI step reads as correct until the cwd it was resolved against is shown.
      expect(() => resolveWorkspaceArgument('no-such-workspace-dir', 'cmd-one', onError)).toThrow(
         `<workspace> does not exist: 'no-such-workspace-dir' resolved to ${path.resolve('no-such-workspace-dir')}`
      );
   });

   it('reports the usage problem against the calling subcommand', () => {
      expect(() => resolveWorkspaceArgument(MISSING_DIR, 'cmd-three', onError)).toThrow('(hydranium-cli cmd-three --help)');
   });

   it('refuses a path that names a file rather than a directory', () => {
      const file = path.join(scratch, 'not-a-directory');
      writeFileSync(file, '');

      // Distinct from the missing case: the traversal reads a file path as
      // silently as a missing one, so "exists" alone is not the property.
      expect(() => resolveWorkspaceArgument(file, 'cmd-one', onError)).toThrow(`<workspace> is not a directory: '${file}'`);
   });

   it('accepts an existing but empty directory', () => {
      // A workspace with no documents validating clean is an answer, not a bad
      // argument, and the binary is language-agnostic so it cannot judge whether
      // the files present belong to the language anyway.
      const empty = mkdtempSync(path.join(scratch, 'empty-'));

      expect(resolveWorkspaceArgument(empty, 'cmd-one', onError)).toBe(empty);
   });

   it('converts a file: URI to a path, which the headless seams cannot do themselves', () => {
      // They resolve a string workspace as a filesystem PATH, so an unconverted
      // URI becomes `<cwd>/file:/…` and reaches nothing — the same silent route
      // this check exists to close.
      expect(resolveWorkspaceArgument(pathToFileURL(EXISTING_DIR).href, 'cmd-one', onError)).toBe(EXISTING_DIR);
      expect(() => resolveWorkspaceArgument(pathToFileURL(MISSING_DIR).href, 'cmd-one', onError)).toThrow(`resolved to ${MISSING_DIR}`);
   });

   it('refuses a file URI it cannot turn into a path, rather than resolving the text', () => {
      // The two platforms reject this at DIFFERENT seams, so one literal
      // cannot assert both. On POSIX a non-localhost host makes the URI
      // unconvertible and `fileURLToPath` throws. On Windows the same text is
      // a legal UNC path, so it converts and the failure moves to reaching the
      // host. What must hold everywhere is that it surfaces as a usage error
      // naming `<workspace>`, never as a raw filesystem throw.
      const expected =
         process.platform === 'win32'
            ? /<workspace> (is not reachable|does not exist)/
            : /<workspace> is not a usable file URI: 'file:\/\/remote-host\/models'/;
      expect(() => resolveWorkspaceArgument('file://remote-host/models', 'cmd-one', onError)).toThrow(expected);
   });
});

describe('exitWithUsage', () => {
   it('reports the message on stderr and exits 2, not 1', () => {
      // 2 is the whole point: a CI step reading 1 as "the workspace has errors"
      // could not tell that apart from "I passed a bad flag" while both exited 1.
      // `process.exit` is stubbed rather than called — it would end the worker.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const exitSpy = vi
         .spyOn(process, 'exit')
         .mockImplementation((() => undefined) as unknown as (code?: number | string | null) => never);

      expect(() => exitWithUsage('Unknown option: --nope (hydranium-cli cmd-one --help)')).not.toThrow();

      expect(errorSpy).toHaveBeenCalledWith('Unknown option: --nope (hydranium-cli cmd-one --help)');
      expect(exitSpy).toHaveBeenCalledWith(2);
      exitSpy.mockRestore();
      errorSpy.mockRestore();
   });
});

describe('assertRequired', () => {
   it('passes a present value through and names the missing one with its help', () => {
      expect(assertRequired('value', '--uri', 'cmd-one', onError)).toBe('value');
      expect(() => assertRequired(undefined, '--uri', 'cmd-one', onError)).toThrow(
         'Missing required option: --uri (hydranium-cli cmd-one --help)'
      );
   });
});

describe('numericOption', () => {
   it('converts a numeric value, passes an absent one through, and reports a non-numeric one', () => {
      expect(numericOption('25', '--edits', onError)).toBe(25);
      expect(numericOption(undefined, '--edits', onError)).toBeUndefined();
      expect(() => numericOption('soon', '--edits', onError)).toThrow('Option --edits expects a number, got: soon');
   });

   it('rejects a value that parses to a non-finite number', () => {
      // `Number('Infinity')` is a number and would otherwise reach a caller that
      // uses it as a loop bound.
      expect(() => numericOption('Infinity', '--edits', onError)).toThrow('Option --edits expects a number, got: Infinity');
   });
});

describe('parseServerSpawnOptions', () => {
   it('splits the --server spec into a command and its arguments', () => {
      const parsed = parseServerSpawnOptions(['--server', 'node ./server.js --stdio'], 'cmd-three', onError);

      expect(parsed.serverCommand).toBe('node');
      expect(parsed.serverArgs).toEqual(['./server.js', '--stdio']);
   });

   it('claims --cwd and --log-level, and leaves everything else as extra', () => {
      const parsed = parseServerSpawnOptions(
         ['--server', 'node s.js', '--cwd', '/tmp/here', '--log-level', 'debug', '--uri', 'file:///a.x'],
         'cmd-three',
         onError
      );

      expect(parsed.cwd).toBe('/tmp/here');
      expect(parsed.logLevel).toBe('debug');
      expect(parsed.extra).toEqual(['--uri', 'file:///a.x']);
   });

   it('rejects an unrecognised --log-level by naming the vocabulary', () => {
      // This one throws from the protocol package rather than reaching onError:
      // the level names are its to report, and the entry point's catch turns the
      // throw into the same message-and-exit.
      expect(() => parseServerSpawnOptions(['--server', 'node s.js', '--log-level', 'chatty'], 'cmd-three', onError)).toThrow(
         /^Invalid --log-level: chatty \(expected one of: /
      );
   });

   it('demands a --server, and refuses one that names nothing', () => {
      expect(() => parseServerSpawnOptions(['--uri', 'file:///a.x'], 'cmd-three', onError)).toThrow(
         'Missing required option: --server (hydranium-cli cmd-three --help)'
      );
      expect(() => parseServerSpawnOptions(['--server', '   '], 'cmd-three', onError)).toThrow('Empty --server value');
   });

   it('refuses a relative --server path when --cwd re-roots the child', () => {
      // An ABSOLUTE path proves nothing here: absolute paths are unaffected by
      // the re-rooting, so the pair below is what separates the two.
      expect(() =>
         parseServerSpawnOptions(['--server', 'node ./lib/data-server-main.js', '--cwd', '/tmp/ws'], 'cmd-three', onError)
      ).toThrow(/--cwd re-roots the spawned child, so the relative path '\.\/lib\/data-server-main\.js' in --server/);
      expect(parseServerSpawnOptions(['--server', 'node /abs/data-server-main.js', '--cwd', '/tmp/ws'], 'cmd-three', onError).cwd).toBe(
         '/tmp/ws'
      );
      // A relative COMMAND is refused on the same grounds, separator alone.
      expect(() => parseServerSpawnOptions(['--server', 'bin/serve.sh', '--cwd', '/tmp/ws'], 'cmd-three', onError)).toThrow(
         /the relative path 'bin\/serve\.sh' in --server/
      );
      // Without --cwd the child keeps the parent's directory, so the shell's own
      // reading of the path is the one that applies and nothing is refused.
      expect(parseServerSpawnOptions(['--server', 'node ./lib/data-server-main.js'], 'cmd-three', onError).serverArgs).toEqual([
         './lib/data-server-main.js'
      ]);
      // A non-path argument must not be mistaken for one: the guess this avoids
      // is exactly why the check refuses rather than re-rooting.
      expect(parseServerSpawnOptions(['--server', 'node srv.js --stdio', '--cwd', '/tmp/ws'], 'cmd-three', onError).serverArgs).toEqual([
         'srv.js',
         '--stdio'
      ]);
   });

   it('reports a shared flag left without its value', () => {
      expect(() => parseServerSpawnOptions(['--server'], 'cmd-three', onError)).toThrow('Missing value for --server');
      expect(() => parseServerSpawnOptions(['--server', 'node s.js', '--cwd'], 'cmd-three', onError)).toThrow('Missing value for --cwd');
      expect(() => parseServerSpawnOptions(['--server', 'node s.js', '--log-level'], 'cmd-three', onError)).toThrow(
         'Missing value for --log-level'
      );
   });
});

describe('parseFlagOptions', () => {
   it('maps a kebab flag onto a camelCase property', () => {
      expect(parseFlagOptions(['--uri', 'file:///a.x', '--client-id', 'tester'], 'cmd-three', ['--uri', '--client-id'], onError)).toEqual({
         uri: 'file:///a.x',
         clientId: 'tester'
      });
   });

   it('refuses a token the subcommand does not recognise, rather than ignoring it', () => {
      expect(() => parseFlagOptions(['--nope', 'x'], 'cmd-three', ['--uri'], onError)).toThrow(
         'Unknown option: --nope (hydranium-cli cmd-three --help)'
      );
   });

   it('reports a recognised flag left without its value', () => {
      expect(() => parseFlagOptions(['--uri'], 'cmd-three', ['--uri'], onError)).toThrow('Missing value for --uri');
   });
});

describe('helpRequested', () => {
   const VALUE_FLAGS = ['--services', '--content'];

   it('recognises both spellings and nothing else', () => {
      expect(helpRequested(['--help'], VALUE_FLAGS)).toBe(true);
      expect(helpRequested(['--services', 'M', '-h'], VALUE_FLAGS)).toBe(true);
      expect(helpRequested(['--services', 'M', '/ws'], VALUE_FLAGS)).toBe(false);
   });

   /**
    * Both directions, in one test on purpose. Asserting only that a value is
    * data would pass against an implementation that stopped recognising help
    * altogether, and asserting only that help still works would pass against the
    * scan-everything version this replaced. Neither alone distinguishes them.
    */
   it('reads a value position as data, while still honouring a flag position after one', () => {
      expect(helpRequested(['--content', '--help'], VALUE_FLAGS)).toBe(false);
      expect(helpRequested(['--content', '-h'], VALUE_FLAGS)).toBe(false);
      expect(helpRequested(['--content', 'text', '--help'], VALUE_FLAGS)).toBe(true);
   });

   it('treats a trailing value flag as consuming nothing, so the argv ends without help', () => {
      // The parser reports the missing value; this only has to not claim help.
      expect(helpRequested(['--content'], VALUE_FLAGS)).toBe(false);
   });

   it('cannot tell a value from a flag when given no value flags', () => {
      // The default is the old scan-everything behaviour, correct only for a
      // command whose flags take no values — hence every caller passes its list.
      expect(helpRequested(['--content', '--help'])).toBe(true);
   });
});
