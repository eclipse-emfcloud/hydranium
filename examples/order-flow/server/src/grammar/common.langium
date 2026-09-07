// Shared lexical basis for all three order-flow grammars. Imported, never
// registered: it has no entry rule and no `langium-config.json` entry, so it is
// a fragment rather than a language.
//
// This mirrors Langium's own multi-grammar example (`examples/requirements`,
// where `common.langium` holds the terminals for `requirements` and `tests`).
// The alternative — leaving the terminals in `domain.langium` and having
// `process.langium` import the whole language to reach them — works, because
// grammar imports are transitive, but it conflates "the shared token set" with
// "a language that happens to also be imported". Keeping them apart means
// `process.langium` imports `domain` for its TYPES and `common` for its TOKENS,
// and those are separate reasons.

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w_]*/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
