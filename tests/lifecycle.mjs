import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BoundedExecutorService,
  CapabilityPlatformService,
  CoordinationLayerService,
  StorageSubstrateService
} from "../dist/index.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "capability-workbench-test-"));

try {
  const storage = new StorageSubstrateService(dataRoot);
  const coordination = new CoordinationLayerService(storage);
  const environmentUpdates = [];
  const environmentPort = {
    async updateState(update) {
      environmentUpdates.push(update);
    }
  };
  const platform = new CapabilityPlatformService(storage, coordination, environmentPort);
  const executor = new BoundedExecutorService(storage);

  await platform.initialize();
  assert.equal(environmentUpdates.at(-1).ready, true);

  const packageId = "cap.text.normalizer";
  const initial = await platform.getPackage(packageId);
  assert.ok(initial);
  assert.equal(initial.releases.length, 0);

  const firstValidation = await platform.validatePackage(packageId);
  assert.equal(firstValidation.ok, true);
  const firstPublish = await platform.publishPackage(packageId);
  assert.equal(firstPublish.releases.length, 1);
  const firstReleaseId = firstPublish.publishedRelease.releaseId;
  assert.equal(firstPublish.publishedForms.length, 4);

  await platform.saveDraft(packageId, {
    name: "Text Normalizer",
    description: "Normalize and label whitespace in a deterministic string.",
    entrypoint: "normalize_text",
    sourceText: [
      "def normalize_text(text: str) -> str:",
      "    return 'normalized:' + ' '.join(text.split())"
    ].join("\n"),
    metadata: { owner: "capability-platform", example: "synthetic" },
    sourceLanguage: "python",
    packageKind: "function",
    sourceMode: "authored",
    publishOutputs: ["source", "json", "text", "runtime-entrypoint"]
  });
  assert.equal((await platform.validatePackage(packageId)).ok, true);
  const secondPublish = await platform.publishPackage(packageId);
  assert.equal(secondPublish.releases.length, 2);
  assert.notEqual(secondPublish.publishedRelease.releaseId, firstReleaseId);

  const rollback = await platform.rollbackPackage(packageId, firstReleaseId);
  assert.equal(rollback.releases.length, 3);
  assert.equal(rollback.publishedRelease.rollbackOfReleaseId, firstReleaseId);

  const execution = await platform.executeGovernedPackageAction(executor, {
    packageId,
    requestedByOwnerId: "capability-platform",
    payload: { value: "  hello   lifecycle  " }
  });
  assert.equal(execution.authorization.ok, true);
  assert.equal(
    execution.executorRun.status,
    "complete",
    JSON.stringify(execution.executorRun.failures)
  );
  assert.equal(execution.evidence.status, "complete");
  assert.equal(JSON.parse(execution.executorRun.outputs[0].body).output, "hello lifecycle");

  const detail = await platform.getPackage(packageId);
  assert.equal(detail.packageEvents.some((event) => event.type === "rolled-back-by-publication"), true);
  assert.equal(detail.packageActionExecutions.length, 1);

  console.log("Capability package lifecycle test passed.");
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}
