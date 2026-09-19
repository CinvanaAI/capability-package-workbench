# Capability Package Workbench: mechanism

[openPackageWorkbench](../src/consumer.ts) creates a real registered local environment and starts without seed packages. [CapabilityPlatformService](../src/owners/capability-platform/src/service.ts) exposes `createPackage`, `saveDraft`, `validatePackage`, `publishPackage` and `executeGovernedPackageAction`. Each publication stores source and metadata in a release snapshot. Editing the draft does not mutate that snapshot; rollback makes a new publication from a prior release. JSON record replacement is atomic.

## Limits that matter

Python actions run trusted source in a subprocess. Package validation checks structure and entrypoint expectations, not arbitrary program safety or correctness. Workspace policy flags are not an authentication service. For a separate consumer, build, `npm pack`, install the local archive, then import `openPackageWorkbench` from `capability-package-workbench`.

## Demonstration contract

Input: A new Python title-normalizer draft and a whitespace-heavy title.

Expected observation: Unpublished request denied; release one returns hello packages after the draft is edited.

The bundled example uses synthetic material. Its observed output establishes that bounded path, not every possible integration.
