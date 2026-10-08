<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hydranium-logo-dark.svg">
    <img src="docs/assets/hydranium-logo.svg" alt="" width="128" height="128">
  </picture>
</p>

<h1 align="center">Hydranium</h1>

<p align="center">
  Text, diagrams and forms on one live model, for modeling languages built on
  <a href="https://langium.org/">Langium</a>.
</p>

Hydranium is a framework for building modeling-language servers. One server
holds the models of your language, and three heads serve them: LSP for text
editors, GLSP for diagrams, and a typed data API for forms, trees and code
generators. Every editor works on the same live model, an edit in one shows up
in the others, and the model files on disk stay the source of truth.

<p align="center">
  <a href="https://eclipse-emfcloud.github.io/hydranium/"><b>▶ Try the live demo</b></a>,
  in your browser, with nothing to install
</p>

<p align="center">
  <a href="https://eclipse-emfcloud.github.io/hydranium/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/demo-dark.png">
      <img src="docs/assets/demo-light.png" alt="A process diagram above the text it is edited from, in the live demo" width="720">
    </picture>
  </a>
</p>

## Why Hydranium

- **One model, many editors.** A text editor, a diagram and a form edit the
  same document at once, and the server coordinates their edits so that none
  silently overwrites another.
- **Files stay the truth.** Models are plain text files in your repository,
  readable in a diff and reviewable like code.
- **Built on Langium.** Your grammar, scoping and validation are ordinary
  Langium. Hydranium adds the heads, the shared workspace and the coordination
  around them.
- **Host it where you need it.** Client libraries for Theia, and examples for
  VS Code and for a plain browser page with no backend at all.

## Architecture

<p align="center">
  <img src="docs/img/architecture.svg" alt="An editor host connects over one channel per protocol to a Hydranium server, whose heads share one Langium workspace over the model files on disk" width="720">
</p>

An editor host talks to one Hydranium server over a channel per protocol. The
server runs the LSP, data and GLSP heads, and any protocol head of your own, on
one shared Langium workspace, which loads and saves the model files on disk.

## Try it

```bash
npx @hydranium/cli init ./my-lang --name MyLang
```

This scaffolds a buildable language server with a starter grammar.
[Adopting Hydranium](docs/ADOPTING.md) takes it from there.

## Status

Alpha. The API still changes between releases, and every merge to `main`
publishes a prerelease to npm. [Status and limitations](docs/adopting/status.md)
says what that means for you and what is known to be missing.

## Where to go next

- **Building a modeling language?** Start with
  [Adopting Hydranium](docs/ADOPTING.md): getting started, the examples, guides
  and reference.
- **Working on Hydranium itself?** Start with
  [Contributing](docs/CONTRIBUTING.md): setup, conventions, testing and
  releasing.

## License

Licensed under the [MIT License](LICENSE). Third-party copyrights are preserved
in the headers of the files that carry them, and [`NOTICE.md`](NOTICE.md)
records the notices the dependency licences require.

## Trademarks

Eclipse and the Eclipse logo are registered trademarks of the Eclipse
Foundation. GLSP, Theia, EMF, and other product names mentioned herein may be
trademarks of their respective owners.
