# Dor CLI

Dormouse ships with a `dor` CLI. The goal of the CLI is to allow programmatic control of Dormouse features. To the extent possible.

## Shim and path prepending

TODO

## cmux compatibility

We try to be compatible with [the public cmux API](https://cmux.com/docs/api) so that it is easy for users to move back and forth between the two applications. Some key differences:

- cmux allows multiple tabs within a split, Dormouse allows only a single tab. cmux calls a given split a "Pane", and a tab within that split a "Surface". Our CLI uses the `surface` terminology for compatibility with cmux, and we support the `--surface` argument
- cmux has multiple workspaces, for now we only have one, so we do not support the `--workspace` argument
- cmux allows multiple windows, for now we do not support cutting across VS Code and the standalone, so we do not support the `--window` argument
- cmux has a CLI tool and a socket API, dormouse has only a CLI tool

The following cmux commands shall be fully implemented:

- `new-split`
- `list-surfaces`
- `focus-surface`
