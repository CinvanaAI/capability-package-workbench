import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openPackageWorkbench } from "capability-package-workbench";

const root = process.argv[2] ?? await mkdtemp(path.join(os.tmpdir(), "package-demo-"));
const { platform, executor } = await openPackageWorkbench(root);
const packageId = "demo.title";
const draft = { name: "Title normalizer", description: "Collapse whitespace in a title.", entrypoint: "normalize_title",
  sourceLanguage: "python", sourceText: "def normalize_title(value):\n    return ' '.join(value.split())",
  metadata: { example: "synthetic" }, packageKind: "function" };
await platform.createPackage({ packageId, draft });
const before = await platform.authorizePackageAction({ packageId, requestedByOwnerId: "capability-platform" });
assert.equal(before.ok, false);
await platform.validatePackage(packageId);
const published = await platform.publishPackage(packageId);
const releaseId = published.publishedRelease.releaseId;
await platform.saveDraft(packageId, { ...draft, sourceText: "def normalize_title(value):\n    return 'DRAFT ONLY'" });
const run = await platform.executeGovernedPackageAction(executor, { packageId, requestedByOwnerId: "capability-platform", payload: { value: "  hello    packages  " } });
assert.equal(run.executorRun.status, "complete", JSON.stringify(run.executorRun.failures));
const output = JSON.parse(run.executorRun.outputs[0].body).output;
assert.equal(output, "hello packages");
assert.equal((await platform.getPackage(packageId)).publishedRelease.releaseId, releaseId);
console.log(JSON.stringify({ unpublishedAuthorized: before.ok, releaseVersion: published.publishedRelease.version,
  output, draftEditChangedPublishedOutput: false, evidenceRoot: root }, null, 2));
