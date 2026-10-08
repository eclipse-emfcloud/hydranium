/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Shared harness for the webview specs: the `test` object every spec imports,
 * with server-log capture composed in, and the launcher that starts VS Code on
 * a private copy of the fixture workspace with this extension loaded.
 */

import { captureServerLog, forwardBrowserConsole, serverLogFixtures, type ServerLogFixtures } from '@hydranium/core/testing/playwright';
import { makeScratchWorkspace, type ScratchWorkspace } from '@hydranium/core/testing/node';
import { _electron, expect, test as base, type ElectronApplication, type FrameLocator, type Page } from '@playwright/test';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import * as path from 'node:path';
import { VSCODE_VERSION } from '../vscode-version.mjs';

const EXTENSION_ROOT = path.resolve(import.meta.dirname, '..', '..');
const WORKSPACE_SOURCE = path.resolve(EXTENSION_ROOT, '..', 'workspace');

/**
 * Workspace path of the VS Code the current spec launched, for the server-log
 * fixture. Module-scoped because the specs launch once in `beforeAll`, whose
 * closure a per-test fixture cannot reach.
 */
let activeWorkspacePath = '';

// The config published the capture directory; this turns it into the variables
// the language server reads. VS Code passes its environment on to the extension
// host, which forks the server with it.
Object.assign(process.env, captureServerLog().env);

interface OrderFlowFixtures extends ServerLogFixtures {
   serverLogCapture: void;
}

/** Use this in place of `@playwright/test`'s `test`: a failure carries the server log. */
export const test = base.extend<OrderFlowFixtures>({
   ...serverLogFixtures,
   // eslint-disable-next-line no-empty-pattern
   serverLogWorkspace: async ({}, use) => {
      await use(activeWorkspacePath);
   }
});

/** A running VS Code and what it owns. */
export interface OrderFlowVscode {
   readonly app: ElectronApplication;
   readonly page: Page;
   readonly workspace: ScratchWorkspace;
   close(): Promise<void>;
}

/**
 * Start the pinned VS Code with this extension, on a copy of the fixture
 * workspace and a fresh profile: a reused profile restores the last run's
 * editors, and with them webviews the spec did not open.
 */
export async function launchOrderFlowVscode(): Promise<OrderFlowVscode> {
   const executablePath = await downloadAndUnzipVSCode({ version: VSCODE_VERSION, cachePath: path.join(EXTENSION_ROOT, '.vscode-test') });
   const workspace = makeScratchWorkspace({ seed: WORKSPACE_SOURCE, prefix: 'order-flow-vscode-e2e-' });
   const profile = makeScratchWorkspace({ prefix: 'order-flow-vscode-profile-' });
   let app: ElectronApplication | undefined;
   const close = async (): Promise<void> => {
      try {
         await app?.close();
      } finally {
         workspace.dispose();
         profile.dispose();
      }
   };
   try {
      app = await _electron.launch({
         executablePath,
         args: [
            // The flags `@vscode/test-electron` launches its own test instances with.
            '--no-sandbox',
            '--disable-gpu-sandbox',
            '--disable-updates',
            '--skip-welcome',
            '--skip-release-notes',
            '--disable-workspace-trust',
            '--disable-extensions',
            `--extensionDevelopmentPath=${EXTENSION_ROOT}`,
            `--user-data-dir=${profile.resolve('user-data')}`,
            `--extensions-dir=${profile.resolve('extensions')}`,
            workspace.root
         ]
      });
      const page = await app.firstWindow();
      activeWorkspacePath = workspace.root;
      forwardBrowserConsole(page, workspace.root);
      await expect(page.locator('.monaco-workbench')).toBeVisible({ timeout: 30_000 });
      return { app, page, workspace, close };
   } catch (error: unknown) {
      await close();
      throw error;
   }
}

/**
 * Run `command` from the palette by clicking its row: the palette ranks fuzzy
 * matches, so Enter can run a different command.
 */
export async function runCommand(page: Page, command: string): Promise<void> {
   await page.keyboard.press('Control+Shift+P');
   const input = page.locator('.quick-input-widget input');
   await expect(input).toBeVisible();
   await input.fill(`>${command}`);
   // A row's accessible name is its label, then its keybinding after a comma.
   const label = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
   await page
      .locator('.quick-input-list')
      .getByRole('option', { name: new RegExp(`^${label}(,|$)`) })
      .click();
   // The palette closing is what says the command was accepted.
   await expect(page.locator('.quick-input-widget')).toBeHidden();
}

/** Open `relativePath` through Quick Open, so the editor is the one a user would get. */
export async function quickOpen(page: Page, relativePath: string): Promise<void> {
   await page.keyboard.press('Control+P');
   const input = page.locator('.quick-input-widget input');
   await expect(input).toBeVisible();
   await input.fill(relativePath);
   await expect(page.locator('.quick-input-list .monaco-list-row').first()).toContainText(path.basename(relativePath));
   await input.press('Enter');
   await expect(page.locator('.quick-input-widget')).toBeHidden();
}

/**
 * The document inside the webview on screen, two iframes deep. Unambiguous only
 * while one webview is open, which the specs keep to.
 */
export function webview(page: Page): FrameLocator {
   return page.frameLocator('iframe.webview.ready').frameLocator('#active-frame');
}
