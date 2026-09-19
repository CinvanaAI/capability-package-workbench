import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageSubstrateService } from "capability-package-workbench";
const root = await mkdtemp(path.join(os.tmpdir(), "storage-atomic-test-"));
try {
  const storage = new StorageSubstrateService(root);
  await storage.putRecord("demo", "records", "one", { version: 0, body: "x".repeat(100000) });
  await Promise.all([
    (async () => { for (let i = 1; i <= 50; i++) await storage.putRecord("demo", "records", "one", { version: i, body: "x".repeat(100000) }); })(),
    (async () => { for (let i = 0; i < 100; i++) {
      const records = await storage.listRecords("demo", "records");
      assert.equal(records.length, 1);
      assert.equal(records[0].body.length, 100000);
    } })()
  ]);
  assert.equal((await storage.getRecord("demo", "records", "one")).version, 50);
  console.log("Concurrent readers observed only complete JSON records.");
} finally { await rm(root, { recursive: true, force: true }); }
