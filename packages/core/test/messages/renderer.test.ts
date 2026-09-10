/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The server-side render seam: the identity / pass-through split, the locale
 * read, and the no-throw contract that keeps a throwing adopter catalogue from
 * losing a message.
 */

import { defineMessage, messageData, messageError } from '@hydranium/protocol';
import { ResponseError } from 'vscode-jsonrpc';
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { describe, expect, it } from 'vitest';
import { DefaultMessageRenderer, type MessageRenderer } from '../../src/messages/index.js';
import { makeCapturingLogger, makeNoopSharedServices } from '../../src/testing/index.js';
import type { ServerSharedServicesMinimal } from '../../src/langium/shared-services.js';

/** Neutral-abstract declaration; the code shape is what a catalogue is keyed by. */
const THING_MISSING = defineMessage('hydranium/core/thing-missing', "No thing named '{name}'.");

const CATALOGUES: Record<string, Record<string, string>> = {
   'xx-AA': { [THING_MISSING.code]: "AA: kein Ding '{name}'." },
   'yy-BB': { [THING_MISSING.code]: "BB: nada '{name}'." }
};

/** The one override an adopter with i18n needs. */
class CatalogueRenderer extends DefaultMessageRenderer {
   protected override translationsFor(locale: string | undefined): Record<string, string> | undefined {
      return locale === undefined ? undefined : CATALOGUES[locale];
   }
}

/** An adopter catalogue with a bad key — the failure the no-throw contract exists for. */
class ThrowingRenderer extends DefaultMessageRenderer {
   protected override translationsFor(): Record<string, string> | undefined {
      throw new Error('missing catalogue key');
   }
}

/** A tree with `renderer` on the `MessageRenderer` slot, plus a capturing logger. */
function makeTree(renderer?: (services: ServerSharedServicesMinimal) => MessageRenderer) {
   const capture = makeCapturingLogger();
   const services = makeNoopSharedServices({ Logger: capture.logger, MessageRenderer: renderer });
   return {
      locale: services.ServerLocale,
      renderer: services.MessageRenderer,
      emitted: () => capture.lines.map(line => line.message).join('\n')
   };
}

/** A diagnostic carrying a framework identity, as `acceptMessage` produces. */
function identityDiagnostic(name: string): Diagnostic {
   return {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: THING_MISSING.format({ name }),
      code: THING_MISSING.code,
      data: messageData(THING_MISSING, { name })
   };
}

/** A diagnostic with no framework identity, as Langium's own validators produce. */
function foreignDiagnostic(message: string, langiumCode?: string): Diagnostic {
   return {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message,
      data: langiumCode === undefined ? undefined : { code: langiumCode }
   };
}

describe('DefaultMessageRenderer', () => {
   it('passes an identity-bearing message through when no catalogue is installed', () => {
      // The framework ships English only and selects no locale, so this is the
      // shipped behaviour rather than a degenerate case.
      const tree = makeTree();
      tree.locale.accept('xx-AA');

      expect(tree.renderer.renderDiagnostic(identityDiagnostic('Widget'))).toBe("No thing named 'Widget'.");
   });

   it('renders from the installed catalogue, parameters included', () => {
      const tree = makeTree(services => new CatalogueRenderer(services));
      tree.locale.accept('xx-AA');

      // The parameterised form, which client-side rendering could not deliver to
      // the squiggle: no Monaco marker field carries the params.
      expect(tree.renderer.renderDiagnostic(identityDiagnostic('Widget'))).toBe("AA: kein Ding 'Widget'.");
   });

   it('reads the locale per render, so an init after construction is still seen', () => {
      // Services compose before `initialize`, so a renderer built at DI time
      // always predates the locale. One that cached it would answer English
      // forever with nothing to say so.
      const tree = makeTree(services => new CatalogueRenderer(services));
      const diagnostic = identityDiagnostic('Widget');

      expect(tree.renderer.renderDiagnostic(diagnostic)).toBe("No thing named 'Widget'.");
      tree.locale.accept('xx-AA');
      expect(tree.renderer.renderDiagnostic(diagnostic)).toBe("AA: kein Ding 'Widget'.");
      tree.locale.accept('yy-BB');
      expect(tree.renderer.renderDiagnostic(diagnostic)).toBe("BB: nada 'Widget'.");
   });

   it('looks a catalogue up once per LOCALE, not once per message', () => {
      // A workspace-wide validation renders once per diagnostic, so the naive
      // override — read a file, build a map — would pay that per diagnostic.
      // Counted rather than timed: a timing assertion on microtasks is the
      // control-failure shape that passes in both states.
      let lookups = 0;
      const tree = makeTree(
         services =>
            new (class extends CatalogueRenderer {
               protected override translationsFor(locale: string | undefined): Record<string, string> | undefined {
                  lookups++;
                  return super.translationsFor(locale);
               }
            })(services)
      );
      const diagnostic = identityDiagnostic('Widget');
      tree.locale.accept('xx-AA');

      tree.renderer.renderDiagnostic(diagnostic);
      tree.renderer.renderDiagnostic(diagnostic);
      tree.renderer.renderDiagnostic(diagnostic);
      expect(lookups).toBe(1);

      // A second locale is a second key, so the memo cannot answer the wrong
      // catalogue — the risk memoizing introduces, asserted rather than assumed.
      tree.locale.accept('yy-BB');
      expect(tree.renderer.renderDiagnostic(diagnostic)).toBe("BB: nada 'Widget'.");
      expect(lookups).toBe(2);
   });

   it('caches the ABSENCE of a catalogue too, which is the framework default', () => {
      // The hot path: shipping none. A memo that only stored truthy answers
      // would re-run the override on every message in exactly the configuration
      // every adopter without i18n runs.
      let lookups = 0;
      const tree = makeTree(
         services =>
            new (class extends DefaultMessageRenderer {
               protected override translationsFor(): Record<string, string> | undefined {
                  lookups++;
                  return undefined;
               }
            })(services)
      );
      const diagnostic = identityDiagnostic('Widget');
      tree.locale.accept('zz-ZZ');

      tree.renderer.renderDiagnostic(diagnostic);
      tree.renderer.renderDiagnostic(diagnostic);

      expect(lookups).toBe(1);
   });

   it('passes a message with no framework identity through unchanged', () => {
      const tree = makeTree(services => new CatalogueRenderer(services));
      tree.locale.accept('xx-AA');

      // Langium's own sentences, reachable only from `data.code`. The framework
      // does not attempt them; an adopter overriding `renderDiagnostic` can.
      expect(tree.renderer.renderDiagnostic(foreignDiagnostic('Expecting token of type ID.', 'parsing-error'))).toBe(
         'Expecting token of type ID.'
      );
      expect(tree.renderer.renderDiagnostic(foreignDiagnostic('Something with no data at all.'))).toBe('Something with no data at all.');
   });

   it('reads the string form of a markup message', () => {
      const tree = makeTree(services => new CatalogueRenderer(services));
      const markup: Diagnostic = { ...foreignDiagnostic(''), message: { kind: 'markdown', value: '**bold**' } };

      expect(tree.renderer.renderDiagnostic(markup)).toBe('**bold**');
   });

   it('renders an RPC error from its identity and passes a plain one through', () => {
      const tree = makeTree(services => new CatalogueRenderer(services));
      tree.locale.accept('xx-AA');

      expect(tree.renderer.renderError(messageError(-32603, THING_MISSING, { name: 'Widget' }))).toBe("AA: kein Ding 'Widget'.");
      expect(tree.renderer.renderError(new ResponseError(-32603, 'A plain rejection.'))).toBe('A plain rejection.');
   });

   describe('the no-throw contract', () => {
      it('keeps a diagnostic when the catalogue throws, and logs', () => {
         const tree = makeTree(services => new ThrowingRenderer(services));
         tree.locale.accept('xx-AA');

         // Asserted on the TEXT, not a count: an empty result and a swallowed
         // error look alike, and the message has to arrive untranslated.
         expect(tree.renderer.renderDiagnostic(identityDiagnostic('Widget'))).toBe("No thing named 'Widget'.");
         // Logged, because the fallback output is byte-identical to a
         // correctly-configured default — otherwise a throwing catalogue is invisible.
         expect(tree.emitted()).toContain('missing catalogue key');
         expect(tree.emitted()).toContain('a diagnostic');
      });

      it('keeps an RPC error message when the catalogue throws', () => {
         const tree = makeTree(services => new ThrowingRenderer(services));
         tree.locale.accept('xx-AA');

         expect(tree.renderer.renderError(messageError(-32603, THING_MISSING, { name: 'Widget' }))).toBe("No thing named 'Widget'.");
         expect(tree.emitted()).toContain('an RPC error');
      });

      it('keeps a directly-held message when the catalogue throws', () => {
         const tree = makeTree(services => new ThrowingRenderer(services));
         tree.locale.accept('xx-AA');

         // The resolved English, not the template: a failed RENDER still has the
         // interpolated text, so a `{name}` reaching a toast would be a
         // regression rather than a fallback.
         expect(tree.renderer.renderMessage(THING_MISSING, { name: 'Widget' })).toBe("No thing named 'Widget'.");
         expect(tree.emitted()).toContain(THING_MISSING.code);
      });

      it('keeps a message whose own `format` throws, which is the only case with no resolved text', () => {
         // A declaration is an adopter-supplied object, so `format` is arbitrary
         // code and is inside the guard with the render. Nothing else can reach
         // this arm, which is why the fallback is the uninterpolated template.
         const hostile = {
            ...THING_MISSING,
            format: () => {
               throw new Error('format exploded');
            }
         };
         const tree = makeTree(services => new CatalogueRenderer(services));
         tree.locale.accept('xx-AA');

         expect(tree.renderer.renderMessage(hostile, { name: 'Widget' })).toBe(THING_MISSING.text);
         expect(tree.emitted()).toContain('format exploded');
      });

      it('logs nothing when the catalogue succeeds', () => {
         const tree = makeTree(services => new CatalogueRenderer(services));
         tree.locale.accept('xx-AA');

         tree.renderer.renderDiagnostic(identityDiagnostic('Widget'));

         expect(tree.emitted()).not.toContain('failed');
      });
   });

   it('renders a directly-held message, for a carrier with no identity slot', () => {
      // GLSP's action protocol is the case: no member of its actions can carry a
      // code, so the raise site is the last place that knows which message it is.
      const tree = makeTree(services => new CatalogueRenderer(services));
      tree.locale.accept('xx-AA');

      expect(tree.renderer.renderMessage(THING_MISSING, { name: 'Widget' })).toBe("AA: kein Ding 'Widget'.");
   });
});

describe('ServerLocale', () => {
   it('reports no locale until an init supplies one', () => {
      // The state of every process no init reaches — the CLI, a test harness —
      // and the reason `accept` takes no `undefined` to reset to it.
      expect(makeTree().locale.value).toBeUndefined();
   });

   it('reports the locale it was handed', () => {
      const tree = makeTree();
      tree.locale.accept('xx-AA');
      expect(tree.locale.value).toBe('xx-AA');
   });
});
