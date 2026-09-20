# Capability Package Workbench

Keep an editable capability draft separate from the exact release an action executes. Validate, publish locally, inspect old releases and roll back by making a new publication.

This library comes from the TypeScript Skeleton rebuild and has its own empty-workspace consumer API. No desktop application or model provider is needed. [Origin](ORIGIN.md)

## Follow three releases

Node.js 20+ and Python 3.10+ on PATH, from this checkout:

```sh
npm ci
npm run demo
npm run check
npm test
```

[The example](examples/first-package.mjs) defines a tiny Python title normalizer and executes it through the actual subprocess boundary. [The captured result](examples/captured-result.json) shows:

| Moment | Observed behavior |
| --- | --- |
| Unpublished draft | Execution authorization denied |
| Publish v1 | Whitespace-heavy input returns `hello packages` |
| Edit the draft | v1 still returns `hello packages` |
| Publish that draft as v2 | Same input returns `DRAFT ONLY` |
| Roll back to v1 | New v3 returns `hello packages`, including after reopening the workspace |

All three releases remain inspectable; the example compares the retained v1 record with its original. “Publish” means create a release in this local workspace, not upload to GitHub or npm. Local evidence is left in the printed temporary directory; the public capture omits that machine path.

## Use the library in your own Node project

```sh
npm run build
npm pack --pack-destination ..
mkdir ../package-consumer
cd ../package-consumer
npm init -y
npm install ../capability-package-workbench-0.1.0.tgz
```

Save as `example.mjs` and run `node example.mjs`:

```js
import { openPackageWorkbench } from "capability-package-workbench";
const { platform } = await openPackageWorkbench("./workspace");
await platform.createPackage({ packageId: "example.greeting", draft: {
  name: "Greeting", description: "A synthetic trusted function", entrypoint: "greet",
  sourceLanguage: "python", sourceText: "def greet():\n    return 'hello'",
  metadata: {}, packageKind: "function"
} });
await platform.validatePackage("example.greeting");
const published = await platform.publishPackage("example.greeting");
console.log(published.publishedRelease.version); // 1
```

Use a new workspace or package ID when creating again. Follow the full demo to authorize and execute a release. Installation above uses a local archive; this repository does not claim an npm registry release.

## Source and extension boundary

[openPackageWorkbench](src/consumer.ts) creates storage, coordination, environment and executor services. [CapabilityPlatformService](src/owners/capability-platform/src/service.ts) manages the lifecycle:

- `saveDraft` changes editable source and clears its validation.
- `validatePackage` checks the draft's structure and entrypoint expectations.
- `publishPackage` stores source/forms and release evidence.
- `executeGovernedPackageAction` selects the published release and records authorization/execution.
- `rollbackPackage` republishes a prior snapshot as a new version; history remains.
- `getPackage` exposes current draft, published release, all releases, policies and action records.

A host can build its own editing surface around these calls. The prior release is the execution boundary even while new source is being edited.

## Limits

The Python subprocess runs **trusted source** with ordinary process authority. Validation does not prove program safety or correctness; policy flags are not authentication. Use a single writer. JSON replacement is atomic per file, while a publication spans multiple records.

The next useful work is a crash-recovery contract across those records, plus a separately enforced sandbox before accepting untrusted packages. Neither is implied by a successful example.

[Mechanism](docs/MECHANISM.md) · [Lifecycle checks](tests/lifecycle.mjs) · [Security](SECURITY.md) · [License](LICENSE.md)
