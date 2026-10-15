# bookstore-vscode-servers

A VS Code extension that starts the Bookstore server and contributes no editor,
view or command: the languages, their grammars and the server. With a socket
head, it also answers each head’s port under a host command, which a host
without a language client of its own runs: the Theia application in
`../host-theia-browser`, which sideloads this extension. The VS Code extension
in `../host-vscode` starts the server through the same function. Both work side
by side, but each starts its own server and language client, so diagnostics may
show twice: install one.

```bash
npm run build   # copy the server’s grammars and compile into out/; build the server first
```

- `src/extension.ts` — activation, which starts the server and, with a socket head, registers its port commands
- `src/language-client.ts` — the server launch, shared with `../host-vscode`
