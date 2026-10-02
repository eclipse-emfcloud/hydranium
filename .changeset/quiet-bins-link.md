---
'@hydranium/cli': patch
---

The `hydranium-cli` bin is a committed `bin/hydranium-cli.js` that loads
`lib/cli.js`, so npm links it on a workspace's first install, before anything
is built. A clone that depends on the CLI through a workspace no longer needs a
second `npm install` after its first build.
