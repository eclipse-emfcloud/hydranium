/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ResponseError } from 'vscode-jsonrpc';

/**
 * The framework externalizes user-facing strings and SELECTS no locale: it
 * relays the one its client declared and renders with whatever templates the
 * adopter installed, defaulting to its English. Every such string carries a
 * stable code beside that English, and exactly one side renders it — the side
 * that knows the reading user's language.
 *
 * Which side that is depends on the message, not on the package. A server
 * message is rendered by the server, at the one seam every carrier passes
 * through, in the locale it was handed at init. A message the client tier raises
 * is rendered there, because those fire when the server is unreachable. Nothing
 * is rendered twice: two renders of one sentence are two authorities over it,
 * and they diverge on the first reword.
 *
 * Codes are `hydranium/<unscoped-package>/<name>`. The package segment locates
 * the declaration, so a message is declared in the package that raises it and a
 * code never names a package it does not live in. `.` and `:` are forbidden in a
 * segment: they are i18next's default key and namespace separators, where either
 * silently becomes a nested lookup that misses.
 */
export type MessageParams = Readonly<Record<string, string | number>>;

type Placeholder<S extends string> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Placeholder<Rest> : never;

export type ParamsOf<S extends string> = [Placeholder<S>] extends [never]
   ? Record<never, never>
   : Readonly<Record<Placeholder<S>, string | number>>;

/** Required exactly when the text has placeholders, absent when it does not. */
export type ParamsArg<S extends string> = [Placeholder<S>] extends [never] ? [] : [params: ParamsOf<S>];

/**
 * Rejects a text argument already widened to `string`. Load-bearing rather than
 * defensive: the whole compile-time guarantee is conditional on `S` inferring a
 * literal, and for a concatenated or pre-widened text the placeholder set
 * silently becomes empty, `format()` accepts no arguments, and the missing
 * substitution surfaces only at runtime.
 */
export type LiteralText<S extends string> = string extends S ? never : S;

export interface MessageDefinition<S extends string> {
   readonly code: string;
   readonly text: S;
   format(...args: ParamsArg<S>): string;
}

/**
 * Declare a message. Placeholder names are inferred from `text` rather than
 * declared again in a type argument: a second spelling of every name is the
 * repetition that drifts, since adding a placeholder to the sentence and not to
 * the type compiles.
 */
export function defineMessage<S extends string>(code: string, text: LiteralText<S>): MessageDefinition<S> {
   const literal = text as S;
   return { code, text: literal, format: (...args) => interpolate(literal, args[0] ?? {}) };
}

const PLACEHOLDER = /\{([^}]+)\}/g;

/**
 * Substitute `{name}` tokens, leaving an unfilled token in place.
 *
 * It must not throw. This runs over an adopter's translation as well as our own
 * text, so a typo in a foreign catalogue has to degrade to a slightly wrong
 * sentence rather than raise inside a toast render. Re-scanning the result to
 * detect an unfilled token is what an earlier form did, and it cannot work:
 * `String.replace` does not rescan replacement text, so the check could not tell
 * an unfilled placeholder from user data shaped like one — an element literally
 * named `{separator}` crashed at the authoring site.
 */
export function interpolate(template: string, params: MessageParams): string {
   // Indexed rather than `key in params`: a hand-built or version-skewed
   // identity can arrive with no params at all, and `in` throws on a non-object
   // where a lookup degrades.
   const lookup = params as Record<string, string | number | undefined> | undefined;
   return template.replace(PLACEHOLDER, (match, key: string) => {
      const value = lookup?.[key];
      return value === undefined ? match : String(value);
   });
}

export interface MessageIdentity {
   readonly code: string;
   readonly params: MessageParams;
}

/**
 * Envelope for a protocol `data` field. Namespaced under one key so it co-exists
 * with a carrier's own `data` conventions rather than occupying `data` itself.
 */
export interface HydraniumMessageData {
   readonly hydranium: MessageIdentity;
}

/** An identity plus its resolved English — everything a renderer needs, on any carrier. */
export interface ResolvedMessage extends MessageIdentity {
   readonly text: string;
}

export function messageData<S extends string>(message: MessageDefinition<S>, ...args: ParamsArg<S>): HydraniumMessageData {
   return { hydranium: { code: message.code, params: args[0] ?? {} } };
}

/**
 * Identity plus resolved English, for a hand-off carrying a value rather than a
 * protocol field. The result is structured-clone safe, so it survives a process
 * hop where one intervenes and costs nothing where none does.
 */
export function resolve<S extends string>(message: MessageDefinition<S>, ...args: ParamsArg<S>): ResolvedMessage {
   return { code: message.code, text: message.format(...args), params: args[0] ?? {} };
}

/**
 * Validates every field {@link MessageIdentity} declares, `params` included.
 * A guard over foreign input that checks only `code` while declaring `params`
 * non-optional hands `undefined` to the renderer, which fails with the worst
 * polarity available: invisible in English, crashing only once a translation is
 * loaded.
 */
export function hasMessageIdentity(data: unknown): data is HydraniumMessageData {
   if (typeof data !== 'object' || data === null || Array.isArray(data) || !('hydranium' in data)) {
      return false;
   }
   const identity = (data as { hydranium: unknown }).hydranium;
   if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) {
      return false;
   }
   const candidate = identity as Partial<MessageIdentity>;
   return typeof candidate.code === 'string' && typeof candidate.params === 'object' && candidate.params !== null;
}

/**
 * A type alias rather than a subclass. Only `code`, `message` and `data` cross
 * the wire, so a subclass buys nothing there: `instanceof` does not survive
 * reconstruction, and the subclass costs an `Object.setPrototypeOf` in every
 * constructor purely to undo what `ResponseError`'s own constructor does.
 */
export type HydraniumResponseError = ResponseError<HydraniumMessageData>;

/**
 * The numeric `code` and the message's catalogue code are unrelated and both are
 * needed: `ResponseError.code` is an `integer`, so it cannot hold a
 * `hydranium/…` key, and it is what a caller switches on after reconstruction.
 */
export function messageError<S extends string>(
   code: number,
   message: MessageDefinition<S>,
   ...params: ParamsArg<S>
): HydraniumResponseError {
   return new ResponseError(code, message.format(...params), messageData(message, ...params));
}

/**
 * Render on the side that knows the reading user's locale. `translations` is
 * whatever flat `code → template` map the host exposes; omitting it is how an
 * adopter without i18n opts out, and yields the English.
 */
export function renderFrameworkMessage(message: ResolvedMessage, translations?: Record<string, string>): string {
   const template = translations?.[message.code];
   return template ? interpolate(template, message.params) : message.text;
}

export function resolvedFromResponseError(error: ResponseError<unknown>): ResolvedMessage | undefined {
   return hasMessageIdentity(error.data) ? { ...error.data.hydranium, text: error.message } : undefined;
}

/**
 * The detail half of a `{detail}` placeholder. A technical error string is safe
 * to pass as a parameter for the same reason a number is: it is not itself
 * translatable text, so it needs no code of its own. A PROSE fragment is not,
 * and must become one code per value instead.
 */
export function describeError(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
}

/**
 * Recognises a declaration among a barrel's exports. The `format` check is what
 * discriminates: a `code` + `text` pair alone admits any object that happens to
 * carry both.
 */
export function isMessageDeclaration(value: unknown): value is MessageDefinition<string> {
   const candidate = value as { code?: unknown; text?: unknown; format?: unknown } | null;
   return (
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof candidate.code === 'string' &&
      typeof candidate.text === 'string' &&
      typeof candidate.format === 'function'
   );
}

/**
 * Every declaration a `./messages` barrel exports.
 *
 * A caller cannot get there with `Object.values(barrel).filter(isMessageDeclaration)`:
 * a barrel's value type is a union of its declarations AND its functions, and
 * `filter` will not narrow a function type down to a `MessageDefinition`, so the
 * result stays the union and reading `.code` off it does not compile. Taking the
 * barrel as an opaque object is what makes the one-liner work.
 */
export function collectMessages(barrel: object): MessageDefinition<string>[] {
   return (Object.values(barrel) as unknown[]).filter(isMessageDeclaration);
}
