# Contributing to logql-apollo-plugin

Thank you for your interest in contributing! This document covers everything you need to get started.

<!--
## Code of Conduct

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to uphold it.
-->

## Reporting bugs

Please [open an issue](https://github.com/logqlio/logql-apollo-plugin/issues/new?template=bug_report.md) using the bug report template. Include as much detail as possible — the version of the plugin, Node, and Apollo Server you are using are especially helpful.

## Suggesting features or changes

For anything beyond a small fix (typos, documentation, trivial corrections), please **open an issue before submitting a PR**. This lets us align on the approach before you invest time writing code. PRs without a linked issue for non-trivial changes may be closed.

## Development setup

**Prerequisites:** Node.js (see `.node-version`) and Yarn 1.x.

```sh
git clone https://github.com/logqlio/logql-apollo-plugin.git
cd logql-apollo-plugin
yarn install
```

### Useful commands

```sh
yarn test          # run the test suite
yarn test --coverage  # run tests with coverage report
yarn lint          # run ESLint
yarn lint:fix      # auto-fix lint issues
yarn fmt           # auto-format with Prettier
yarn prettier --check .  # check formatting without writing
```

The project enforces 100% line coverage. New code must be covered by tests.

## Submitting a pull request

1. Fork the repository and create a branch from `main`.
2. Make your changes, including tests for any new behaviour.
3. Ensure `yarn lint`, `yarn prettier --check .`, and `yarn test --coverage` all pass locally.
4. Open a PR against `main` and fill in the description. Link it to the relevant issue.

PRs are reviewed by maintainers on a best-effort basis. Please be patient — this is a small open-source project.

## Commit style

No strict convention is enforced, but please write clear, descriptive commit messages in the imperative mood (e.g. `Fix retry logic for failed requests`).

## Releasing

Releases are handled by maintainers. Publishing to npm happens automatically via GitHub Actions when a new GitHub Release is created.
