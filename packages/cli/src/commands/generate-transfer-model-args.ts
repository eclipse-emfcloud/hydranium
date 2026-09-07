/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'node:fs';
import { deriveAstFileFromLangiumConfig, loadTransferModelConfig, mergeTransferModelOptions } from './generate-transfer-model-config.js';
import { generateTransferModel, watchTransferModel, type GenerateTransferModelOptions } from './generate-transfer-model.js';
import { exitWithUsage, helpRequested, printHelp, type UsageError } from './harness-args.js';
import { wireSigintAbort } from './watch.js';

/**
 * Every flag `generate-transfer-model` accepts.
 *
 * Listed rather than derived: this command takes no `--services` and no
 * positional, so it parses its own switch instead of going through the shared
 * harness parser, and there is no flag set to derive the list from. A test
 * therefore drives the parser with each name to prove the switch has a case for
 * it, which the harness-backed commands get for free.
 */
export const GENERATE_TRANSFER_MODEL_FLAGS: readonly string[] = [
   '--config',
   '--langium-config',
   '--watch',
   '--ast-file',
   '--augmentation-file',
   '--out-file',
   '--element-type-name',
   '--terminals-name',
   '--terminals-source-name',
   '--skip-type-alias',
   '--skip-terminal',
   '--regen-command'
];

/**
 * The subset that takes a value, so `--help` in a value position reads as data.
 * `--watch` is the only presence-only flag; `--regen-command` is the one where a
 * caller plausibly writes that literal text into a generated header.
 */
export const GENERATE_TRANSFER_MODEL_VALUE_FLAGS: readonly string[] = GENERATE_TRANSFER_MODEL_FLAGS.filter(flag => flag !== '--watch');

/** The `--help` text, as data, held to {@link GENERATE_TRANSFER_MODEL_FLAGS} by a test. */
export const GENERATE_TRANSFER_MODEL_HELP: readonly string[] = [
   'Usage: hydranium-cli generate-transfer-model [options]',
   '',
   'Generate a serializable transfer-model TypeScript file from a Langium AST. The',
   'required inputs (--ast-file / --augmentation-file / --out-file) may instead come',
   'from a --config JSON file, and --ast-file can be auto-discovered from a Langium',
   "config's `out` directory. Precedence, highest first: explicit flags, then the",
   '--config file, then the langium-config-derived --ast-file.',
   '',
   'Options:',
   '  --config <path>               JSON config supplying any of the options below.',
   "                                Relative paths resolve against the config's dir.",
   "  --langium-config <path>       Derive --ast-file from this config's `out` dir",
   '                                (<out>/ast.ts). Defaults to ./langium-config.json.',
   '  --watch                       Regenerate on AST / augmentation file changes.',
   '  --ast-file <path>             Langium-generated AST source file (required).',
   '  --augmentation-file <path>    Module-augmentation file (required).',
   '  --out-file <path>             Destination for the generated transfer model (required).',
   "                                Do NOT point this inside langium-cli's own `out`",
   '                                directory: it treats that directory as exclusively',
   '                                its own, so every `langium generate` reports this',
   '                                file as unexpected and offers to delete it.',
   '  --element-type-name <name>    Base element type name in output. Default: TransferElement.',
   '  --terminals-name <name>       Terminals const name in output. Default: ModelTerminals.',
   '  --terminals-source-name <n>   Source-side terminals variable name. Default: <LanguageId>Terminals.',
   '  --skip-type-alias <name>      Type alias to exclude (repeatable).',
   '  --skip-terminal <name>        Terminal to exclude (repeatable).',
   '  --regen-command <text>        Header line shown in the generated file (regen instructions).'
];

/** The flags as read, before any config file or langium-config derivation is folded in. */
export interface ParsedGenerateOptions {
   flags: Partial<GenerateTransferModelOptions>;
   configFile?: string;
   langiumConfigFile?: string;
   watch: boolean;
}

export function parseGenerateOptions(args: string[], onError: UsageError = exitWithUsage): ParsedGenerateOptions {
   const skipTypeAliases: string[] = [];
   const skipTerminals: string[] = [];
   const flags: Partial<GenerateTransferModelOptions> = {};
   let configFile: string | undefined;
   let langiumConfigFile: string | undefined;
   let watch = false;

   for (let index = 0; index < args.length; index += 1) {
      const flag = args[index];
      const next = (): string => {
         const value = args[index + 1];
         if (value === undefined) {
            onError(`Missing value for ${flag}`);
         }
         index += 1;
         return value;
      };
      switch (flag) {
         case '--config':
            configFile = next();
            break;
         case '--langium-config':
            langiumConfigFile = next();
            break;
         case '--watch':
            watch = true;
            break;
         case '--ast-file':
            flags.astFile = next();
            break;
         case '--augmentation-file':
            flags.augmentationFile = next();
            break;
         case '--out-file':
            flags.outFile = next();
            break;
         case '--element-type-name':
            flags.elementTypeName = next();
            break;
         case '--terminals-name':
            flags.terminalsName = next();
            break;
         case '--terminals-source-name':
            flags.terminalsSourceName = next();
            break;
         case '--skip-type-alias':
            skipTypeAliases.push(next());
            break;
         case '--skip-terminal':
            skipTerminals.push(next());
            break;
         case '--regen-command':
            flags.regenCommand = next();
            break;
         default:
            onError(`Unknown option: ${flag}`);
      }
   }

   // Only record the repeatable arrays when the flag actually appeared, so an empty
   // `--skip-*` doesn't shadow a config-file value in the merge (first-defined-wins).
   if (skipTypeAliases.length) {
      flags.skipTypeAliases = skipTypeAliases;
   }
   if (skipTerminals.length) {
      flags.skipTerminals = skipTerminals;
   }

   return { flags, configFile, langiumConfigFile, watch };
}

/**
 * Only auto-detect the default `./langium-config.json` when it exists — an explicit
 * `--langium-config` always wins and is returned as-is (the caller reports errors if
 * it is unreadable).
 */
function resolveLangiumConfigPath(explicit: string | undefined): string | undefined {
   if (explicit !== undefined) {
      return explicit;
   }
   return fs.existsSync('langium-config.json') ? 'langium-config.json' : undefined;
}

export function runGenerateTransferModelCommand(args: string[]): void | Promise<void> {
   if (helpRequested(args, GENERATE_TRANSFER_MODEL_VALUE_FLAGS)) {
      printHelp(GENERATE_TRANSFER_MODEL_HELP);
      return;
   }

   const parsed = parseGenerateOptions(args);

   // Assemble option sources highest-precedence first: explicit flags, then the
   // --config file, then a langium-config-derived --ast-file. Merge validates the
   // three required paths are present after all sources are considered.
   const sources: Array<Partial<GenerateTransferModelOptions>> = [parsed.flags];
   if (parsed.configFile !== undefined) {
      sources.push(loadTransferModelConfig(parsed.configFile));
   }
   const langiumConfig = resolveLangiumConfigPath(parsed.langiumConfigFile);
   if (langiumConfig !== undefined) {
      const derivedAstFile = deriveAstFileFromLangiumConfig(langiumConfig);
      if (derivedAstFile !== undefined) {
         if (parsed.langiumConfigFile !== undefined) {
            console.log(`Deriving --ast-file from ${langiumConfig}: ${derivedAstFile}`);
         }
         sources.push({ astFile: derivedAstFile });
      }
   }

   const options = mergeTransferModelOptions(...sources);
   if (parsed.watch) {
      const controller = new AbortController();
      const unwire = wireSigintAbort(controller);
      return watchTransferModel(options, { signal: controller.signal }).finally(() => unwire());
   }
   generateTransferModel(options);
}
