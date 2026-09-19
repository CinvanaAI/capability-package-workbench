import type { HostEnvironmentProjection } from "../../framework/src/contracts.js";

export interface ExecutionEnvironmentDefinition {
  environmentId: string;
  ownerId: string;
  label: string;
  summary: string;
  stations?: ExecutionEnvironmentStation[];
  rules?: ExecutionEnvironmentRule[];
  settings?: ExecutionEnvironmentSettings;
  skins?: ExecutionEnvironmentSkin[];
}

export interface ExecutionEnvironmentStation {
  stationId: string;
  label: string;
  ownerId: string;
  purpose: string;
  actionIds: string[];
}

export interface ExecutionEnvironmentRule {
  ruleId: string;
  summary: string;
  enforcement: "advisory" | "blocking";
}

export interface ExecutionEnvironmentSettings {
  lifecycle: "static" | "session" | "instance";
  readinessChecks: string[];
  ownerRefs: string[];
}

export interface ExecutionEnvironmentSkin {
  skinId: string;
  label: string;
  ownerId: string;
  assetRef?: string;
}

export interface ExecutionEnvironmentState extends HostEnvironmentProjection {
  lifecycle: ExecutionEnvironmentSettings["lifecycle"];
  readinessChecks: string[];
  ownerRefs: string[];
  stations: ExecutionEnvironmentStation[];
  rules: ExecutionEnvironmentRule[];
  skins: ExecutionEnvironmentSkin[];
  activeSkinId?: string;
  updatedAt: string;
}

export type BoundedExecutorActionKind = "agent.workflow" | "capability.package-action";
export type BoundedExecutorRunStatus = "queued" | "running" | "complete" | "failed" | "denied";

export interface BoundedExecutorPermissionCheck {
  checkId: string;
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

export interface BoundedExecutorPermissionDecision {
  ok: boolean;
  checkedAt: string;
  summary: string;
  checks: BoundedExecutorPermissionCheck[];
  denials: string[];
}

export interface BoundedExecutorEventRecord {
  at: string;
  type: string;
  summary: string;
  details?: Record<string, unknown>;
}

export interface BoundedExecutorOutputRecord {
  outputId: string;
  label: string;
  mediaType: string;
  body: string;
  createdAt: string;
}

export interface BoundedExecutorFailureRecord {
  at: string;
  summary: string;
  details?: Record<string, unknown>;
}

export interface BoundedExecutorRunRecord {
  runId: string;
  actionKind: BoundedExecutorActionKind;
  actionId: string;
  requestedByOwnerId: string;
  requestedByRecordId?: string;
  environmentId: string;
  ownerRefs: string[];
  status: BoundedExecutorRunStatus;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  permissionDecision: BoundedExecutorPermissionDecision;
  events: BoundedExecutorEventRecord[];
  outputs: BoundedExecutorOutputRecord[];
  failures: BoundedExecutorFailureRecord[];
  permissionDenials: string[];
  input: Record<string, unknown>;
}

export interface BoundedExecutorSubmission {
  actionKind: BoundedExecutorActionKind;
  actionId: string;
  requestedByOwnerId: string;
  requestedByRecordId?: string;
  environmentId: string;
  ownerRefs: string[];
  permissionDecision: BoundedExecutorPermissionDecision;
  input: Record<string, unknown>;
}

export interface BoundedExecutorObservability {
  runCount: number;
  completeCount: number;
  failedCount: number;
  deniedCount: number;
  runningCount: number;
  recentRuns: BoundedExecutorRunRecord[];
}

export interface ExecutionEnvironmentObservability {
  storageRoot: string;
  environmentCount: number;
  readyCount: number;
  degradedCount: number;
  pendingCount: number;
  stationCount: number;
  ruleCount: number;
  skinCount: number;
  executor: BoundedExecutorObservability;
  environments: ExecutionEnvironmentState[];
}
