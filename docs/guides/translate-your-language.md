# Translate your language

Use this when your users should read diagnostics and messages in their own
language. The framework ships English only and picks no locale: it renders in
the locale the client declares, with the translations you supply. Without any,
everything stays English and nothing else changes. The order-flow example
translates into German on the server and in Theia.

Heads: any

## The seam

Every user-facing message carries a stable code beside its English text. The
server renders each message it sends, diagnostics included, through the shared
`MessageRenderer` in the locale the client declared when it connected. You
translate by binding a renderer that knows your catalogue. Text the client
shows on its own, such as command labels, it translates through the host's own
mechanism.

## Steps

1. **Give your own messages codes.** Declare each with `defineMessage`, under a
   namespace of your own, and raise it with `acceptMessage`, as in
   [Add a validation check](add-validation-check.md):
   `defineMessage('my-lang/process/self-transition', "'{step}' cannot transition to itself.")`.
   A code is three `/`-separated segments of lower-case letters, digits and
   hyphens, and no code may be the start of another. `hydranium/` belongs to
   the framework.

2. **Write a catalogue.** A flat JSON object from code to translated text, with
   the same `{name}` placeholders. It covers your codes and any of the
   framework's you want translated; a code it leaves out renders in English, so
   a partial catalogue is fine. To list the framework's codes, call
   `collectMessages` on the `./messages` entry of `@hydranium/core`,
   `@hydranium/protocol`, `@hydranium/data-server` and
   `@hydranium/glsp-server`.

3. **Bind a renderer that uses it.** Subclass `DefaultMessageRenderer` from
   `@hydranium/core/messages`, override `translationsFor(locale)`, and bind it
   on the shared `MessageRenderer` slot:

<!-- snippet-preamble
import { DefaultMessageRenderer } from '@hydranium/core/messages';
import { type Locale, MessageCatalogue } from '@hydranium/protocol';
declare const CATALOGUES: Record<string, MessageCatalogue>;
-->

```ts
export class MyMessageRenderer extends DefaultMessageRenderer {
   protected override translationsFor(locale: Locale | undefined): MessageCatalogue | undefined {
      let language: string | undefined;
      try {
         language = locale ? new Intl.Locale(locale).language : undefined;
      } catch {
         language = undefined;
      }
      return MessageCatalogue.merge(super.translationsFor(locale), language ? CATALOGUES[language] : undefined);
   }
}
```

   Merge over `super`, so a base class's entries still apply, and never throw:
   the answer is cached only when it returns. Matching on the language alone
   gives `de-AT` the German entries; a set with regional variants needs a
   lookup that tries `de-AT` before `de`.

4. **Translate the client's own text.** In Theia, register a
   `LocalizationContribution` on the backend. Give it a `languageName` and
   `languagePack: true`, or Theia never offers the language and drops the
   catalogue without a word, and import the JSON rather than reading it from a
   path, because the backend is bundled into the application. Keep the client's
   keys apart from the server's: each message has one side that renders it.
   The example's catalogue is `theia/src/nls/order-flow.de.json`.

5. **Test the catalogues.** `findUndeclaredCodes` from
   `@hydranium/protocol/testing` reports catalogue keys that name no real code,
   which a running app cannot show you, since a typo and an omission both fall
   back to English. `findSharedCodes` reports keys both sides translate. The
   example's `theia/test/order-flow-localization.test.ts` does both.

## Where the locale comes from

A client declares its locale when it connects. VS Code and Theia send the
display language in LSP `initialize`, so one switch changes the editor and the
server's messages together. A headless caller passes `locale` in the options of
`initializeWorkspaceProgrammatically` or `buildWorkspaceProgrammatically`, as a
language tag such as `de-CH`; a POSIX spelling such as `de_DE`, as an
environment variable holds it, matches no catalogue. A Theia backend serves every window at once, so it holds
no locale and renders nothing itself.

## What stays English

A string the server sends without a code, other than as a diagnostic, an RPC
error or a message value, stays English whatever the locale. So do Theia's own
untranslated strings in a partial catalogue.
