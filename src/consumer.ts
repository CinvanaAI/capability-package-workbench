import { CapabilityPlatformService } from "./owners/capability-platform/src/service.js";
import { BoundedExecutorService } from "./owners/execution-environment/src/executor.js";
import { ExecutionEnvironmentDomainService } from "./owners/execution-environment/src/service.js";
import { CoordinationLayerService } from "./owners/coordination/src/service.js";
import { StorageSubstrateService } from "./owners/storage/src/service.js";

/** Open a local single-writer package workspace without installing seed packages. */
export async function openPackageWorkbench(dataRoot: string) {
  const storage = new StorageSubstrateService(dataRoot);
  const coordination = new CoordinationLayerService(storage);
  const executor = new BoundedExecutorService(storage);
  const environments = new ExecutionEnvironmentDomainService(storage, () => executor.inspectObservability());
  await environments.registerEnvironment({ environmentId: "capability-platform", ownerId: "capability-platform", label: "Capability packages", summary: "Local package lifecycle." });
  const platform = new CapabilityPlatformService(storage, coordination, environments);
  await platform.initialize({ seedDefaults: false });
  return { platform, executor };
}
