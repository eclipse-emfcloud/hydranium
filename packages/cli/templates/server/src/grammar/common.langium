// Shared lexical basis for this project's grammars. Imported, never registered:
// it has no entry rule and no `langium-config.json` entry, so it is a fragment
// rather than a language.
//
// Keeping the tokens here rather than in one of the languages means a grammar
// imports `common` for its TOKENS and another language only when it needs that
// language's TYPES — separate reasons that are worth keeping separate.

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w_]*/;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
