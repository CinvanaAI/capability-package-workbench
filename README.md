# Capability Package Workbench

A local library for creating capability packages and executing published snapshots. Drafting, validation, publication, rollback and action evidence remain distinct records.

## Try it

Node.js 20 or newer and Python 3.10 or newer on `PATH`. No model credentials.

```sh
npm ci
npm run demo
```

[examples/first-package.mjs](examples/first-package.mjs) creates a title normalizer from scratch. Execution is refused before publication. After publishing version one, the example changes the draft and runs the published package: the result remains `hello packages`, not the draft’s replacement text. Its printed evidence directory contains the lifecycle and execution records.

## How it works

A reviewed, immutable package snapshot is a clearer execution target than a moving draft. Read the [mechanism and implementation notes](docs/MECHANISM.md) for the specific boundaries and source links.

## Scope

Python actions run trusted source in a subprocess. Package validation checks structure and entrypoint expectations, not arbitrary program safety or correctness. Workspace policy flags are not an authentication service. For a separate consumer, build, `npm pack`, install the local archive, then import `openPackageWorkbench` from `capability-package-workbench`.

## Verify

`npm run check` and `npm test` exercise the original behavior, a consumer-created example and concurrent JSON readers.

MIT licensed; see [LICENSE.md](LICENSE.md). Origin and release boundaries are documented in [ORIGIN.md](ORIGIN.md) and [SECURITY.md](SECURITY.md).
## Inspect the example result

Open the [saved synthetic result](examples/captured-result.json) alongside its [input and demonstration](examples/first-package.mjs). The result is from the bundled synthetic example; local machine paths and temporary run identifiers are excluded from public projections.
