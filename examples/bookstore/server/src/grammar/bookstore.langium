grammar Bookstore

// A minimal starter grammar — replace with your own language. `BookstoreNode` is
// a named, cross-referenceable node, which is enough for `hydranium-cli reflect`,
// `lint-grammar`, and `validate` to work out of the box.
//
// This name is the GRAMMAR's, not the project's: langium-cli emits
// `BookstoreGeneratedModule` from it, while `projectName` in
// langium-config.json emits the shared `BookstoreGeneratedSharedModule` and
// `BookstoreAstReflection`. They match by default and diverge as soon as you add
// a second grammar — that grammar gets its own name here, and the project name
// stays the umbrella.
//
// The rule names carry the grammar's prefix (`BookstoreModel`, `BookstoreNode`)
// because one langium-cli run over N grammars emits ONE combined `ast.ts`: two
// grammars both declaring `entry Model:` would put that interface in it twice.

entry BookstoreModel:
    (nodes+=BookstoreNode)*;

BookstoreNode:
    'node' name=ID ('->' target=[BookstoreNode:ID])?;

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w_]*/;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
