import type { HostEnvironmentStatus } from "../../framework/src/contracts.js";
import type { StorageSubstrateService } from "../../storage/src/service.js";
import type {
  BoundedExecutorObservability,
  ExecutionEnvironmentDefinition,
  ExecutionEnvironmentObservability,
  ExecutionEnvironmentState
} from "./records.js";

const OWNER_ID = "execution-environment";
const COLLECTION = "environment-states";

export class ExecutionEnvironmentDomainService {
  private readonly definitions = new Map<string, ExecutionEnvironmentDefinition>();
  private readonly states = new Map<string, ExecutionEnvironmentState>();

  constructor(
    private readonly storage: StorageSubstrateService,
    private readonly inspectExecutor: () => Promise<BoundedExecutorObservability> = async () => ({
      runCount: 0,
      completeCount: 0,
      failedCount: 0,
      deniedCount: 0,
      runningCount: 0,
      recentRuns: []
    })
  ) {}

  async registerEnvironment(definition: ExecutionEnvironmentDefinition): Promise<void> {
    this.definitions.set(definition.environmentId, definition);
    const stored = await this.storage.getRecord<ExecutionEnvironmentState>(
      OWNER_ID,
      COLLECTION,
      definition.environmentId
    );
    const now = new Date().toISOString();
    this.states.set(definition.environmentId, {
      ...(stored ?? {}),
      environmentId: definition.environmentId,
      ownerId: definition.ownerId,
      label: definition.label,
      status: stored?.status ?? "pending",
      ready: stored?.ready ?? false,
      summary: stored?.summary ?? definition.summary,
      lifecycle: definition.settings?.lifecycle ?? stored?.lifecycle ?? "static",
      readinessChecks: definition.settings?.readinessChecks ?? stored?.readinessChecks ?? [],
      ownerRefs: definition.settings?.ownerRefs ?? stored?.ownerRefs ?? [],
      stations: definition.stations ?? stored?.stations ?? [],
      rules: definition.rules ?? stored?.rules ?? [],
      skins: definition.skins ?? stored?.skins ?? [],
      ...(stored?.activeSkinId ? { activeSkinId: stored.activeSkinId } : {}),
      updatedAt: now
    });
    await this.persist(definition.environmentId);
  }

  async updateState(input: {
    environmentId: string;
    status: HostEnvironmentStatus;
    ready: boolean;
    summary: string;
  }): Promise<void> {
    const current = this.states.get(input.environmentId);
    if (!current) {
      throw new Error(`Environment ${input.environmentId} is not registered.`);
    }
    this.states.set(input.environmentId, {
      ...current,
      status: input.status,
      ready: input.ready,
      summary: input.summary,
      updatedAt: new Date().toISOString()
    });
    await this.persist(input.environmentId);
  }

  listEnvironments(): ExecutionEnvironmentState[] {
    return Array.from(this.states.values()).sort((left, right) =>
      left.label.localeCompare(right.label)
    );
  }

  getEnvironment(environmentId: string): ExecutionEnvironmentState | undefined {
    return this.states.get(environmentId);
  }

  async inspectObservability(): Promise<ExecutionEnvironmentObservability> {
    const environments = this.listEnvironments();
    return {
      storageRoot: this.storage.namespacePath(OWNER_ID),
      environmentCount: environments.length,
      readyCount: environments.filter((environment) => environment.status === "ready").length,
      degradedCount: environments.filter((environment) => environment.status === "degraded").length,
      pendingCount: environments.filter((environment) => environment.status === "pending").length,
      stationCount: environments.flatMap((environment) => environment.stations).length,
      ruleCount: environments.flatMap((environment) => environment.rules).length,
      skinCount: environments.flatMap((environment) => environment.skins).length,
      executor: await this.inspectExecutor(),
      environments
    };
  }

  private async persist(environmentId: string): Promise<void> {
    const state = this.states.get(environmentId);
    if (!state) {
      return;
    }
    await this.storage.putRecord(OWNER_ID, COLLECTION, environmentId, state);
  }
}
