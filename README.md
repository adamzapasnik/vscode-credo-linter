# Credo Linter

## Features

Integrates [Credo](https://github.com/rrrene/credo) into VS Code.

**NOTE:** It also works with a multi-workspace environment.

## Settings

This extension contributes the following settings:

- `credo.enable`: enable/disable this extension
- `credo.command`: credo command that is used to collect problems **DON'T USE FORMAT OPTION**
- `credo.projectDir`: specify mix directory in case Elixir project resides in a subdirectory
- `credo.mixEnv`: MIX_ENV used to run credo, default value is `test`. You shouldn't need to change it. Make sure Credo is available in a `:test` environment.

## Changelog

See Changelog [here](CHANGELOG.md)

## Issues

Submit the [issues](https://github.com/adamzapasnik/vscode-credo-linter/issues) if you find any bug or have any suggestion.

## Contribution

Fork the [repo](https://github.com/adamzapasnik/vscode-credo-linter) and submit pull requests.
