# @hydranium/bookstore-theia

The Bookstore Theia extension: reconnect hardening, a Show Model command reading
a file through the data head, and a diagram editor for each diagram. The
language client is not here: the application sideloads `../vscode-servers`,
which starts the server and answers each socket head’s port under a host
command, and the backend modules forward the page’s channels to those ports. The
application in `../host-theia-browser` runs it.

```bash
npm run build   # compile into lib/; build the protocol and client packages first
```

## Layout

- `src/browser/bookstore-connection-preload-module.ts` and `src/node/bookstore-connection-backend-module.ts` — reconnect hardening, sized by the application’s `connectionBufferBytes`
- `src/browser/bookstore-frontend-module.ts` — the frontend bindings
- `src/browser/bookstore-data-port.ts` and `bookstore-data-connection.ts` — the data head’s connection
- `src/browser/bookstore-show-model-command.ts` — `Bookstore: Show Model`, reading the current file through the data head
- `src/node/bookstore-data-backend-module.ts` — forwards the data channel to the data head’s port
- `src/common/bookstore-glsp-contribution.ts` — the id the GLSP client and its forwarder share
- `src/browser/bookstore-glsp-client-contribution.ts` — the GLSP client every diagram shares
- `src/node/bookstore-glsp-backend-module.ts` — forwards the GLSP channel to the GLSP head’s port
- `src/browser/bookstore-diagram-frontend-module.ts` — the `Bookstore` diagram editor, over the client package’s diagram
- `style/diagram.css` — the diagrams’ colours, from the Theia theme
