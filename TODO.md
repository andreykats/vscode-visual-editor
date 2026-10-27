# TODO

## Marketplace trusted publishing

The Marketplace hasn't launched trusted publishing yet. It's targeted for late October 2026; see vsce issue [#1275](https://github.com/microsoft/vscode-vsce/issues/1275). Until then, the `marketplace` job in `release.yml` fails, and the `.vsix` is uploaded by hand. See [docs/releasing.md](docs/releasing.md).

- [ ] Once launched, add the trusted publishing policy for the `andreykats` publisher at https://marketplace.visualstudio.com/manage: owner `andreykats`, repository `vscode-visual-editor`, workflow `release.yml`, no environment.
- [ ] Release the next extension version and check that the `marketplace` job publishes it.
- [ ] Once vsce 4.0.1 is released, drop the `@vscode/vsce@4.0.1-5` pin in `release.yml`, and update the status note in `docs/releasing.md`.
