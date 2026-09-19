export type CapabilitySourceLanguage = "python" | "text";
export type CapabilityPackageKind = "function" | "composite" | "contract" | "prompt";
export type CapabilitySourceMode = "system-bootstrap" | "authored" | "legacy-import" | "external-registration";
export type CapabilityLifecycleState = "draft" | "published" | "retired";
export type CapabilityDraftState = "open" | "validated" | "published" | "deleted";
export type CapabilityDraftItemKind = "metadata" | "source" | "entrypoint" | "contracts" | "policy";
export type CapabilityPublishedFormKind = "source" | "json" | "text" | "runtime-entrypoint";
export type CapabilitySurfaceId = "published" | "unpublished" | "history" | "artifact" | "policy" | "admin";
export type CapabilitySurfaceAccess = "owner-only" | "granted-consumers" | "public-read";

export interface CapabilityValidationResult {
  checkedAt: string;
  ok: boolean;
  summary: string;
  issues: string[];
}

export interface CapabilityDraftSurface {
  name: string;
  description: string;
  metadata: Record<string, string>;
  entrypoint: string;
  sourceLanguage: CapabilitySourceLanguage;
  packageKind?: CapabilityPackageKind;
  sourceMode?: CapabilitySourceMode;
  componentDependencies?: string[];
  publishOutputs?: CapabilityPublishedFormKind[];
  sourceText: string;
}

export interface CapabilityPackageRecord {
  packageId: string;
  createdAt: string;
  updatedAt: string;
  lifecycleState?: CapabilityLifecycleState;
  liveRecordId?: string;
  openDraftId?: string;
  sourceRegistrationId?: string;
  draft: CapabilityDraftSurface;
  gates: string[];
  surfaceContracts: string[];
  publishedReleaseId?: string;
  releaseIds: string[];
  publicationIds?: string[];
  eventIds?: string[];
  policyIds?: string[];
  draftValidation?: CapabilityValidationResult;
}

export interface CapabilityReleaseRecord {
  releaseId: string;
  packageId: string;
  version: number;
  publishedAt: string;
  entrypoint: string;
  sourceLanguage: CapabilitySourceLanguage;
  validation: CapabilityValidationResult;
  candidateId?: string;
  rollbackOfReleaseId?: string;
  artifactIds?: string[];
  formIds?: string[];
  forms: {
    source: string;
    json: string;
    text: string;
    runtimeEntrypoint?: string;
  };
}

export interface CapabilityLiveRecord {
  liveRecordId: string;
  packageId: string;
  releaseId: string;
  version: number;
  installedAt: string;
  state: "published";
  surfaceContracts: string[];
  formIds: string[];
  artifactIds: string[];
}

export interface CapabilityDraftRecord {
  draftId: string;
  packageId: string;
  state: CapabilityDraftState;
  version: number;
  createdAt: string;
  updatedAt: string;
  baseReleaseId?: string;
  itemIds: string[];
  validation?: CapabilityValidationResult;
}

export interface CapabilityDraftItemRecord {
  draftItemId: string;
  draftId: string;
  packageId: string;
  kind: CapabilityDraftItemKind;
  revision: number;
  state: "changed" | "validated" | "published" | "deleted";
  body: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  validation?: CapabilityValidationResult;
}

export interface CapabilityPublicationCandidateRecord {
  candidateId: string;
  packageId: string;
  draftId?: string;
  createdAt: string;
  version: number;
  publishable: boolean;
  validation: CapabilityValidationResult;
  outputFormKinds: CapabilityPublishedFormKind[];
  snapshot: {
    draft: CapabilityDraftSurface;
    gates: string[];
    surfaceContracts: string[];
  };
}

export interface CapabilityPublicationRecord {
  publicationId: string;
  packageId: string;
  releaseId: string;
  candidateId: string;
  version: number;
  publishedAt: string;
  summary: string;
  state: "published";
  replacedReleaseId?: string;
  rollbackOfReleaseId?: string;
  formIds: string[];
  artifactIds: string[];
}

export interface CapabilityPackageEventRecord {
  eventId: string;
  packageId: string;
  type: string;
  summary: string;
  createdAt: string;
  details?: Record<string, unknown>;
}

export interface CapabilityPublishedFormRecord {
  formId: string;
  packageId: string;
  releaseId: string;
  formKind: CapabilityPublishedFormKind;
  artifactId: string;
  mediaType: string;
  storagePath: string;
  createdAt: string;
  metadata: Record<string, string>;
}

export interface CapabilitySourceRegistrationRecord {
  sourceRegistrationId: string;
  packageId: string;
  sourceMode: CapabilitySourceMode;
  sourceLanguage: CapabilitySourceLanguage;
  sourceRef: string;
  visibility: "owner-local" | "external";
  createdAt: string;
  updatedAt: string;
}

export interface CapabilitySurfacePolicyRecord {
  policyId: string;
  packageId: string;
  surfaceId: CapabilitySurfaceId;
  access: CapabilitySurfaceAccess;
  consumers: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityPackageGrantEvidence {
  ownerId: "agents" | string;
  grantId: string;
  surfaceIds: string[];
  scope?: "local" | "global";
}

export interface CapabilityPackageActionAuthorization {
  ok: boolean;
  checkedAt: string;
  packageId: string;
  surfaceId: CapabilitySurfaceId;
  requestedByOwnerId: string;
  requestedByRecordId?: string;
  releaseId?: string;
  summary: string;
  checks: Array<{
    checkId: string;
    ok: boolean;
    summary: string;
    details?: Record<string, unknown>;
  }>;
  denials: string[];
}

export interface CapabilityPackageActionExecutionRecord {
  executionId: string;
  packageId: string;
  releaseId?: string;
  requestedByOwnerId: string;
  requestedByRecordId?: string;
  executorRunId: string;
  status: "complete" | "failed" | "denied";
  requestedAt: string;
  updatedAt: string;
  inputSummary: string;
  outputCount: number;
  failureCount: number;
  permissionDenials: string[];
}

export interface CapabilityPackageSummary {
  packageId: string;
  name: string;
  description: string;
  publishedReleaseId?: string;
  draftValid: boolean;
  releaseCount: number;
}

export interface CapabilityPackageDetail {
  package: CapabilityPackageRecord;
  publishedRelease?: CapabilityReleaseRecord;
  releases: CapabilityReleaseRecord[];
  liveRecord?: CapabilityLiveRecord;
  drafts: CapabilityDraftRecord[];
  draftItems: CapabilityDraftItemRecord[];
  publicationCandidates: CapabilityPublicationCandidateRecord[];
  publications: CapabilityPublicationRecord[];
  packageEvents: CapabilityPackageEventRecord[];
  publishedForms: CapabilityPublishedFormRecord[];
  packageActionExecutions: CapabilityPackageActionExecutionRecord[];
  sourceRegistration?: CapabilitySourceRegistrationRecord;
  surfacePolicies: CapabilitySurfacePolicyRecord[];
}

export interface CapabilityPackageSurfaceDetail {
  packageId: string;
  surfaceId: CapabilitySurfaceId;
  policy?: CapabilitySurfacePolicyRecord;
  draft?: CapabilityDraftSurface;
  publishedRelease?: CapabilityReleaseRecord;
  releases?: CapabilityReleaseRecord[];
  publishedForms?: CapabilityPublishedFormRecord[];
  packageEvents?: CapabilityPackageEventRecord[];
}

export interface CapabilityPlatformObservability {
  packageCount: number;
  releaseCount: number;
  publishedCount: number;
  draftCount: number;
  draftItemCount: number;
  publicationCount: number;
  eventCount: number;
  publishedFormCount: number;
  surfacePolicyCount: number;
  sourceRegistrationCount: number;
  packageActionExecutionCount: number;
  gateCount: number;
  legacyImportedCount: number;
  storageRoot: string;
  packages: Array<{
    packageId: string;
    gates: string[];
    surfaceContracts: string[];
    sourceLanguage: CapabilitySourceLanguage;
    publishedReleaseId?: string;
    lifecycleState?: CapabilityLifecycleState;
  }>;
}

export interface LegacyCapabilityImportReport {
  rootsUsed: string[];
  importedCount: number;
  skippedCount: number;
  importedPackages: string[];
  skippedPackages: string[];
}
