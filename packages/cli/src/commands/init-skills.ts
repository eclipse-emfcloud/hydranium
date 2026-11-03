/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { InitWizardCancelled, type PromptPort } from './init-prompt.js';
import { checkSkills } from './skills.js';

export const SKILLS_INSTALLER = 'skills@1.7.6';

export const ADOPTER_SKILLS = {
   'hydranium-profiling': { source: 'eclipse-emfcloud/hydranium', label: 'Hydranium profiling' },
   langium: { source: 'eclipse-langium/langium-ai', label: 'Langium grammar and runtime' }
} as const;

export type AdopterSkill = keyof typeof ADOPTER_SKILLS;

export const SKILL_AGENTS = {
   codex: 'Codex',
   'claude-code': 'Claude Code',
   cursor: 'Cursor',
   'github-copilot': 'GitHub Copilot',
   opencode: 'OpenCode'
} as const;

export type SkillAgent = keyof typeof SKILL_AGENTS;

export interface SkillInstallation {
   readonly skills: readonly AdopterSkill[];
   readonly agents: readonly SkillAgent[];
}

/** Validate before scaffolding so a misspelling cannot leave a half-completed command. */
export function parseSkillInstallation(skills?: string, agents?: string): SkillInstallation | undefined {
   if (skills === undefined && agents === undefined) {
      return undefined;
   }
   if (!skills || !agents) {
      throw new Error('--skills and --agents must be supplied together.');
   }
   const selectedSkills = skills.split(',');
   const selectedAgents = agents.split(',');
   for (const name of selectedSkills) {
      if (!Object.hasOwn(ADOPTER_SKILLS, name)) {
         throw new Error(`Unknown skill '${name}'. Choose ${Object.keys(ADOPTER_SKILLS).join(', ')}.`);
      }
   }
   for (const name of selectedAgents) {
      if (!Object.hasOwn(SKILL_AGENTS, name)) {
         throw new Error(`Unknown agent '${name}'. Choose ${Object.keys(SKILL_AGENTS).join(', ')}.`);
      }
   }
   return { skills: [...new Set(selectedSkills)] as AdopterSkill[], agents: [...new Set(selectedAgents)] as SkillAgent[] };
}

export function skillInstallArgs(skill: AdopterSkill, agents: readonly SkillAgent[]): string[] {
   return ['--yes', SKILLS_INSTALLER, 'add', ADOPTER_SKILLS[skill].source, '--skill', skill, '--agent', ...agents, '--copy', '--yes'];
}

/** A failed optional download leaves the scaffold usable and gives an independently runnable retry. */
export function installSkills(
   project: string,
   from: string,
   selection: SkillInstallation,
   write: (message: string) => void = message => process.stdout.write(message)
): void {
   for (const skill of selection.skills) {
      const args = skillInstallArgs(skill, selection.agents);
      write(`\nIn ${project}: npx ${args.join(' ')}\n`);
      try {
         // Only catalogued names reach the Windows shim's shell; paths travel as cwd, never shell text.
         const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
            cwd: project,
            stdio: 'inherit',
            shell: process.platform === 'win32'
         });
         if (result.signal === 'SIGINT' || result.status === 130) {
            write('Skill installation cancelled. Scaffold kept.\n');
            return;
         }
         if (result.error || result.signal || result.status !== 0) {
            throw result.error ?? new Error(result.signal ?? `exit code ${result.status}`);
         }
         for (const result of checkSkills(project, from, [skill])) {
            write(`${result.status}: ${result.file}: ${result.detail}\n`);
         }
      } catch (error) {
         write(`Skill installation failed (${error instanceof Error ? error.message : String(error)}). Scaffold kept.\n`);
         write(`Retry in ${project}: npx ${args.join(' ')}\n`);
      }
   }
   const relative = path.relative(project, from) || '.';
   const quoted = `'${relative.replace(/'/g, "'\\''")}'`;
   write(`Check again after installing or updating dependencies: npx hydranium-cli check-skills --from ${quoted}\n`);
}

/** This prompt runs only after the scaffold succeeds; cancelling it cannot undo the scaffold. */
export async function offerSkills(prompt: PromptPort, project: string): Promise<SkillInstallation | undefined> {
   try {
      prompt.intro('Optional coding-agent skills');
      if (!(await prompt.confirm({ message: `Install coding-agent skills in ${project}?`, initialValue: false }))) {
         prompt.outro('Skills skipped.');
         return undefined;
      }
      const skills = await prompt.multiselect<AdopterSkill>({
         message: 'Skills to install',
         choices: Object.entries(ADOPTER_SKILLS).map(([value, skill]) => ({ value: value as AdopterSkill, label: skill.label })),
         initialValues: ['hydranium-profiling', 'langium']
      });
      const agents = await prompt.multiselect<SkillAgent>({
         message: 'Coding agents',
         choices: Object.entries(SKILL_AGENTS).map(([value, label]) => ({ value: value as SkillAgent, label }))
      });
      prompt.outro('Installing selected skills as project files. Commit the files and skills-lock.json.');
      return { skills, agents };
   } catch (error) {
      if (error instanceof InitWizardCancelled) {
         prompt.outro('Skills skipped. Scaffold kept.');
         return undefined;
      }
      throw error;
   }
}
