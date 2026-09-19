import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root = await mkdtemp(path.join(os.tmpdir(), "capability-package-workbench-consumer-"));
try {
  const output = execFileSync(process.execPath, ["examples/first-package.mjs", root], { encoding: "utf8" });
  assert.ok(JSON.parse(output).evidenceRoot);
  const { openPackageWorkbench } = await import("capability-package-workbench");
  const { platform } = await openPackageWorkbench(root);
  const before = await platform.getPackage("demo.title");
  await assert.rejects(platform.createPackage({ packageId: "demo.title", draft: {} }), /already exists/);
  assert.equal((await platform.getPackage("demo.title")).publishedRelease.releaseId, before.publishedRelease.releaseId);
  await assert.rejects(platform.createPackage({ packageId: "../outside", draft: {} }), /Package ID/);
  await assert.rejects(platform.createPackage({ packageId: undefined, draft: {} }), /Package ID/);
  console.log("Public consumer demonstration passed.");
} finally {
  // The only recursive cleanup target is the exact directory created above.
  await rm(root, { recursive: true, force: true });
}
