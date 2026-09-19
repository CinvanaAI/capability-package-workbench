import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CoordinationLayerService } from "../../coordination/src/service.js";
import type { ExecutionEnvironmentDomainService } from "../../execution-environment/src/service.js";
import type {
  BoundedExecutorPermissionDecision,
  BoundedExecutorRunRecord
} from "../../execution-environment/src/records.js";
import type { BoundedExecutorService } from "../../execution-environment/src/executor.js";
import type { StorageSubstrateService } from "../../storage/src/service.js";
import type {
  CapabilityDraftItemRecord,
  CapabilityDraftRecord,
  CapabilityDraftSurface,
  CapabilityLiveRecord,
  CapabilityPackageActionAuthorization,
  CapabilityPackageActionExecutionRecord,
  CapabilityPackageDetail,
  CapabilityPackageEventRecord,
  CapabilityPackageGrantEvidence,
  CapabilityPackageRecord,
  CapabilityPackageSummary,
  CapabilityPackageSurfaceDetail,
  CapabilityPlatformObservability,
  CapabilityPublicationCandidateRecord,
  CapabilityPublicationRecord,
  CapabilityPublishedFormKind,
  CapabilityPublishedFormRecord,
  CapabilityReleaseRecord,
  CapabilitySourceLanguage,
  CapabilitySourceMode,
  CapabilitySourceRegistrationRecord,
  CapabilitySurfaceId,
  CapabilitySurfacePolicyRecord,
  CapabilityValidationResult,
  LegacyCapabilityImportReport
} from "./records.js";

import { DEFAULT_PACKAGES } from "./default-packages.js";

const OWNER_ID = "capability-platform";
const PACKAGE_COLLECTION = "packages";
const RELEASE_COLLECTION = "releases";
const LIVE_COLLECTION = "live-records";
const DRAFT_COLLECTION = "drafts";
const DRAFT_ITEM_COLLECTION = "draft-items";
const CANDIDATE_COLLECTION = "publication-candidates";
const PUBLICATION_COLLECTION = "publications";
const EVENT_COLLECTION = "package-events";
const FORM_COLLECTION = "published-forms";
const ACTION_EXECUTION_COLLECTION = "package-action-executions";
const SOURCE_COLLECTION = "source-registrations";
const POLICY_COLLECTION = "surface-policies";
const EVENT_STREAM = "package-lifecycle";
const ENVIRONMENT_ID = "capability-platform";
const LIFECYCLE_MIGRATION_ID = "capability-platform.lifecycle.v1";

export type DraftSaveInput = Pick<
  CapabilityDraftSurface,
  "name" | "description" | "entrypoint" | "sourceText" | "metadata"
> &
  Partial<
    Pick<
      CapabilityDraftSurface,
      "sourceLanguage" | "packageKind" | "sourceMode" | "componentDependencies" | "publishOutputs"
    >
  >;

interface LegacyPromptRecord {
  promptId: string;
  title: string;
  summary: string;
  promptText: string;
  governanceFlags: string[];
  benchmarkArtifacts: Array<{
    artifactId: string;
    title: string;
    summary: string;
  }>;
}

export class CapabilityPlatformService {
  constructor(
    private readonly storage: StorageSubstrateService,
    private readonly coordination: CoordinationLayerService,
    private readonly environments: ExecutionEnvironmentDomainService
  ) {}

  async initialize(options: { seedDefaults?: boolean } = {}): Promise<void> {
    let packages = await this.storage.listRecords<CapabilityPackageRecord>(OWNER_ID, PACKAGE_COLLECTION);
    if (packages.length === 0 && options.seedDefaults !== false) {
      await Promise.all(
        DEFAULT_PACKAGES.map((pkg) =>
          this.storage.putRecord(OWNER_ID, PACKAGE_COLLECTION, pkg.packageId, pkg)
        )
      );
      packages = await this.storage.listRecords<CapabilityPackageRecord>(OWNER_ID, PACKAGE_COLLECTION);
    }
    for (const pkg of packages) {
      await this.ensureLifecycleRecords(pkg);
    }
    const migrations = await this.storage.listMigrations(OWNER_ID);
    if (!migrations.some((migration) => migration.migrationId === LIFECYCLE_MIGRATION_ID)) {
      await this.storage.recordMigration({
        ownerId: OWNER_ID,
        migrationId: LIFECYCLE_MIGRATION_ID,
        label: "Capability Platform package lifecycle records",
        status: "applied",
        summary: "Established package drafts, source registrations, surface policies, events, and artifact custody."
      });
    }
    await this.environments.updateState({
      environmentId: ENVIRONMENT_ID,
      status: "ready",
      ready: true,
      summary:
        "Capability Platform environment is mounted with package workbench, lifecycle ledger, published forms, and policy surfaces."
    });
  }

  async listPackages(): Promise<CapabilityPackageSummary[]> {
    const packages = await this.listNormalizedPackages();
    return packages
      .map((pkg) => ({
        packageId: pkg.packageId,
        name: pkg.draft.name,
        description: pkg.draft.description,
        ...(pkg.publishedReleaseId ? { publishedReleaseId: pkg.publishedReleaseId } : {}),
        draftValid: pkg.draftValidation?.ok ?? false,
        releaseCount: pkg.releaseIds.length
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async createPackage(input: { packageId: string; draft: DraftSaveInput }): Promise<CapabilityPackageDetail> {
    if (typeof input.packageId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.packageId)) {
      throw new Error("Package ID must be 1–80 letters, digits, dots, underscores or hyphens.");
    }
    if (await this.storage.getRecord(OWNER_ID, PACKAGE_COLLECTION, input.packageId)) {
      throw new Error(`Package ${input.packageId} already exists.`);
    }
    if (!input.draft.name?.trim() || typeof input.draft.sourceText !== "string" || !input.draft.sourceText.trim()) {
      throw new Error("A new package requires a name and source text.");
    }
    const now = new Date().toISOString();
    const pkg: CapabilityPackageRecord = {
      packageId: input.packageId, createdAt: now, updatedAt: now, lifecycleState: "draft",
      draft: normalizeDraftSurface({ ...structuredClone(input.draft), sourceLanguage: input.draft.sourceLanguage ?? "python", sourceMode: "authored" }),
      gates: ["draft-edit", "publish", "executor-boundary-required"],
      surfaceContracts: ["unpublished-draft", "published-source", "published-json", "history"],
      releaseIds: [], publicationIds: [], eventIds: [], policyIds: []
    };
    await this.storage.putRecord(OWNER_ID, PACKAGE_COLLECTION, pkg.packageId, pkg);
    await this.ensureLifecycleRecords(pkg);
    await this.recordPackageEvent(pkg.packageId, "created", `Created package ${pkg.packageId}.`);
    return (await this.getPackage(pkg.packageId)) as CapabilityPackageDetail;
  }

  async getPackage(packageId: string): Promise<CapabilityPackageDetail | undefined> {
    const pkg = await this.storage.getRecord<CapabilityPackageRecord>(OWNER_ID, PACKAGE_COLLECTION, packageId);
    if (!pkg) {
      return undefined;
    }
    const normalized = await this.ensureLifecycleRecords(pkg);

    const releases = (
      await Promise.all(
        normalized.releaseIds.map((releaseId) =>
          this.storage.getRecord<CapabilityReleaseRecord>(OWNER_ID, RELEASE_COLLECTION, releaseId)
        )
      )
    ).filter((release): release is CapabilityReleaseRecord => Boolean(release));

    const [drafts, draftItems, candidates, publications, packageEvents, publishedForms, actionExecutions, policies] =
      await Promise.all([
        this.storage.listRecords<CapabilityDraftRecord>(OWNER_ID, DRAFT_COLLECTION),
        this.storage.listRecords<CapabilityDraftItemRecord>(OWNER_ID, DRAFT_ITEM_COLLECTION),
        this.storage.listRecords<CapabilityPublicationCandidateRecord>(OWNER_ID, CANDIDATE_COLLECTION),
        this.storage.listRecords<CapabilityPublicationRecord>(OWNER_ID, PUBLICATION_COLLECTION),
        this.storage.listRecords<CapabilityPackageEventRecord>(OWNER_ID, EVENT_COLLECTION),
        this.storage.listRecords<CapabilityPublishedFormRecord>(OWNER_ID, FORM_COLLECTION),
        this.storage.listRecords<CapabilityPackageActionExecutionRecord>(OWNER_ID, ACTION_EXECUTION_COLLECTION),
        this.storage.listRecords<CapabilitySurfacePolicyRecord>(OWNER_ID, POLICY_COLLECTION)
      ]);
    const packageDrafts = drafts.filter((draft) => draft.packageId === packageId);
    const draftIds = new Set(packageDrafts.map((draft) => draft.draftId));
    const sourceRegistration = normalized.sourceRegistrationId
      ? await this.storage.getRecord<CapabilitySourceRegistrationRecord>(
          OWNER_ID,
          SOURCE_COLLECTION,
          normalized.sourceRegistrationId
        )
      : undefined;
    const liveRecord = normalized.liveRecordId
      ? await this.storage.getRecord<CapabilityLiveRecord>(OWNER_ID, LIVE_COLLECTION, normalized.liveRecordId)
      : undefined;

    return {
      package: normalized,
      ...(normalized.publishedReleaseId
        ? {
            publishedRelease: releases.find(
              (release) => release.releaseId === normalized.publishedReleaseId
            )
          }
        : {}),
      releases: releases.sort((left, right) => right.version - left.version),
      ...(liveRecord ? { liveRecord } : {}),
      drafts: packageDrafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      draftItems: draftItems
        .filter((item) => draftIds.has(item.draftId))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      publicationCandidates: candidates
        .filter((candidate) => candidate.packageId === packageId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      publications: publications
        .filter((publication) => publication.packageId === packageId)
        .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt)),
      packageEvents: packageEvents
        .filter((event) => event.packageId === packageId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      publishedForms: publishedForms
        .filter((form) => form.packageId === packageId)
        .sort((left, right) => left.formKind.localeCompare(right.formKind)),
      packageActionExecutions: actionExecutions
        .filter((execution) => execution.packageId === packageId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      ...(sourceRegistration ? { sourceRegistration } : {}),
      surfacePolicies: policies
        .filter((policy) => policy.packageId === packageId)
        .sort((left, right) => left.surfaceId.localeCompare(right.surfaceId))
    };
  }

  async getPackageSurface(
    packageId: string,
    surfaceId: CapabilitySurfaceId
  ): Promise<CapabilityPackageSurfaceDetail | undefined> {
    const detail = await this.getPackage(packageId);
    if (!detail) {
      return undefined;
    }
    const policy = detail.surfacePolicies.find((item) => item.surfaceId === surfaceId);
    return {
      packageId,
      surfaceId,
      ...(policy ? { policy } : {}),
      ...(surfaceId === "unpublished" ? { draft: detail.package.draft } : {}),
      ...(surfaceId === "published" && detail.publishedRelease
        ? { publishedRelease: detail.publishedRelease, publishedForms: detail.publishedForms }
        : {}),
      ...(surfaceId === "history"
        ? { releases: detail.releases, packageEvents: detail.packageEvents }
        : {}),
      ...(surfaceId === "artifact" ? { publishedForms: detail.publishedForms } : {})
    };
  }

  async saveDraft(
    packageId: string,
    input: DraftSaveInput
  ): Promise<CapabilityPackageDetail> {
    const pkg = await this.ensureLifecycleRecords(await this.requirePackage(packageId));
    const draft = await this.ensureOpenDraft(pkg);
    const now = new Date().toISOString();
    const nextSurface: CapabilityDraftSurface = {
      ...pkg.draft,
      name: input.name.trim(),
      description: input.description.trim(),
      entrypoint: input.entrypoint.trim(),
      sourceText: input.sourceText,
      metadata: normalizeStringRecord(input.metadata),
      sourceLanguage: input.sourceLanguage ?? pkg.draft.sourceLanguage,
      packageKind: input.packageKind ?? pkg.draft.packageKind ?? inferPackageKind(pkg.draft.sourceLanguage),
      sourceMode: input.sourceMode ?? pkg.draft.sourceMode ?? inferSourceMode(input.metadata),
      componentDependencies: input.componentDependencies ?? pkg.draft.componentDependencies ?? [],
      publishOutputs: normalizeOutputKinds(input.publishOutputs ?? pkg.draft.publishOutputs)
    };
    const item: CapabilityDraftItemRecord = {
      draftItemId: randomUUID(),
      draftId: draft.draftId,
      packageId,
      kind: "source",
      revision: draft.itemIds.length + 1,
      state: "changed",
      body: {
        name: nextSurface.name,
        description: nextSurface.description,
        entrypoint: nextSurface.entrypoint,
        sourceLanguage: nextSurface.sourceLanguage,
        packageKind: nextSurface.packageKind,
        componentDependencies: nextSurface.componentDependencies,
        publishOutputs: nextSurface.publishOutputs
      },
      createdAt: now,
      updatedAt: now
    };
    const nextDraft: CapabilityDraftRecord = {
      ...draft,
      state: "open",
      updatedAt: now,
      itemIds: [...draft.itemIds, item.draftItemId],
      validation: undefined
    };
    const next: CapabilityPackageRecord = {
      ...pkg,
      updatedAt: now,
      lifecycleState: pkg.publishedReleaseId ? "published" : "draft",
      openDraftId: draft.draftId,
      draft: nextSurface,
      draftValidation: undefined
    };
    await this.storage.putRecord(OWNER_ID, DRAFT_ITEM_COLLECTION, item.draftItemId, item);
    await this.storage.putRecord(OWNER_ID, DRAFT_COLLECTION, draft.draftId, nextDraft);
    await this.storage.putRecord(OWNER_ID, PACKAGE_COLLECTION, packageId, next);
    await this.recordPackageEvent(packageId, "draft-updated", `Updated draft surface for ${packageId}.`, {
      draftId: draft.draftId,
      draftItemId: item.draftItemId
    });
    return (await this.getPackage(packageId)) as CapabilityPackageDetail;
  }

  async validatePackage(packageId: string): Promise<CapabilityValidationResult> {
    const packages = await this.listNormalizedPackages();
    const pkg = packages.find((candidate) => candidate.packageId === packageId);
    if (!pkg) {
      throw new Error(`Capability package ${packageId} was not found.`);
    }
    const validation = validateDraft(pkg, packages);
    const draft = await this.ensureOpenDraft(pkg);
    const now = new Date().toISOString();
    const next: CapabilityPackageRecord = {
      ...pkg,
      updatedAt: now,
      draftValidation: validation
    };
    const nextDraft: CapabilityDraftRecord = {
      ...draft,
      state: validation.ok ? "validated" : "open",
      updatedAt: now,
      validation
    };
    const latestItemId = draft.itemIds.at(-1);
    if (latestItemId) {
      const latestItem = await this.storage.getRecord<CapabilityDraftItemRecord>(
        OWNER_ID,
        DRAFT_ITEM_COLLECTION,
        latestItemId
      );
      if (latestItem) {
        await this.storage.putRecord(OWNER_ID, DRAFT_ITEM_COLLECTION, latestItemId, {
          ...latestItem,
          state: validation.ok ? "validated" : "changed",
          updatedAt: now,
          validation
        } satisfies CapabilityDraftItemRecord);
      }
    }
    await this.storage.putRecord(OWNER_ID, DRAFT_COLLECTION, draft.draftId, nextDraft);
    await this.storage.putRecord(OWNER_ID, PACKAGE_COLLECTION, packageId, next);
    await this.recordPackageEvent(packageId, "validated", `${validation.ok ? "Validated" : "Validation failed for"} ${packageId}.`, {
      packageId,
      ok: validation.ok,
      issues: validation.issues
    });
    return validation;
  }

  async publishPackage(packageId: string): Promise<CapabilityPackageDetail> {
    const pkg = await this.ensureLifecycleRecords(await this.requirePackage(packageId));
    const validation = pkg.draftValidation ?? validateDraft(pkg, await this.listNormalizedPackages());
    if (!validation.ok) {
      await this.recordPackageEvent(packageId, "publish-blocked", `Publish blocked for ${packageId}.`, {
        issues: validation.issues
      });
      throw new Error(`Package ${packageId} cannot publish while validation is failing.`);
    }
    await this.publishSnapshot({
      pkg,
      validation,
      snapshot: pkg.draft,
      draftId: pkg.openDraftId,
      summary: `Published ${packageId} through Capability Platform lifecycle.`
    });
    return (await this.getPackage(packageId)) as CapabilityPackageDetail;
  }

  async rollbackPackage(packageId: string, releaseId: string): Promise<CapabilityPackageDetail> {
    const pkg = await this.ensureLifecycleRecords(await this.requirePackage(packageId));
    if (!pkg.releaseIds.includes(releaseId)) {
      throw new Error(`Release ${releaseId} does not belong to package ${packageId}.`);
    }
    const target = await this.storage.getRecord<CapabilityReleaseRecord>(OWNER_ID, RELEASE_COLLECTION, releaseId);
    if (!target) {
      throw new Error(`Release ${releaseId} was not found.`);
    }
    await this.publishSnapshot({
      pkg,
      validation: target.validation,
      snapshot: draftSurfaceFromRelease(pkg, target),
      rollbackOfReleaseId: releaseId,
      summary: `Republished ${packageId} from historical release ${releaseId}.`
    });
    return (await this.getPackage(packageId)) as CapabilityPackageDetail;
  }

  async authorizePackageAction(input: {
    packageId: string;
    surfaceId?: CapabilitySurfaceId;
    requestedByOwnerId: string;
    requestedByRecordId?: string;
    grantEvidence?: CapabilityPackageGrantEvidence;
  }): Promise<CapabilityPackageActionAuthorization> {
    const checkedAt = new Date().toISOString();
    const surfaceId = input.surfaceId ?? "published";
    const checks: CapabilityPackageActionAuthorization["checks"] = [];
    const denials: string[] = [];
    const pkg = await this.storage.getRecord<CapabilityPackageRecord>(
      OWNER_ID,
      PACKAGE_COLLECTION,
      input.packageId
    );

    const addCheck = (checkId: string, ok: boolean, summary: string, details?: Record<string, unknown>) => {
      checks.push({
        checkId,
        ok,
        summary,
        ...(details ? { details } : {})
      });
      if (!ok) {
        denials.push(summary);
      }
    };

    if (!pkg) {
      addCheck("package-exists", false, `Capability package ${input.packageId} does not exist.`);
      return {
        ok: false,
        checkedAt,
        packageId: input.packageId,
        surfaceId,
        requestedByOwnerId: input.requestedByOwnerId,
        ...(input.requestedByRecordId ? { requestedByRecordId: input.requestedByRecordId } : {}),
        summary: "Package action denied.",
        checks,
        denials
      };
    }

    const normalized = await this.ensureLifecycleRecords(pkg);
    addCheck("package-exists", true, `Capability package ${input.packageId} exists.`);
    addCheck(
      "package-published",
      Boolean(normalized.publishedReleaseId),
      normalized.publishedReleaseId
        ? `Package is published as release ${normalized.publishedReleaseId}.`
        : "Package has no published release."
    );
    const release = normalized.publishedReleaseId
      ? await this.storage.getRecord<CapabilityReleaseRecord>(
          OWNER_ID,
          RELEASE_COLLECTION,
          normalized.publishedReleaseId
        )
      : undefined;
    addCheck(
      "release-readable",
      Boolean(release),
      release ? "Published release record is readable." : "Published release record is missing."
    );
    addCheck(
      "release-validation",
      release?.validation.ok === true,
      release?.validation.ok === true
        ? "Published release validation is passing."
        : "Published release validation is not passing."
    );
    const policy = (await this.ensureSurfacePolicies(normalized)).find(
      (candidate) => candidate.surfaceId === surfaceId
    );
    addCheck(
      "surface-policy-exists",
      Boolean(policy),
      policy ? `Surface policy ${policy.policyId} exists.` : `Surface policy for ${surfaceId} is missing.`
    );
    if (policy) {
      const grantCoversSurface =
        input.grantEvidence?.surfaceIds.includes(surfaceId) ||
        input.grantEvidence?.surfaceIds.includes("published") ||
        input.grantEvidence?.surfaceIds.includes("*");
      const policyAllows =
        input.requestedByOwnerId === OWNER_ID ||
        policy.access === "public-read" ||
        policy.consumers.includes(input.requestedByOwnerId) ||
        (policy.access === "granted-consumers" && Boolean(grantCoversSurface));
      addCheck(
        "surface-policy-allows-requester",
        policyAllows,
        policyAllows
          ? `Surface policy allows ${input.requestedByOwnerId}.`
          : `Surface policy denies ${input.requestedByOwnerId} for ${surfaceId}.`,
        {
          access: policy.access,
          consumers: policy.consumers,
          grantEvidence: input.grantEvidence
        }
      );
    }

    return {
      ok: denials.length === 0,
      checkedAt,
      packageId: input.packageId,
      surfaceId,
      requestedByOwnerId: input.requestedByOwnerId,
      ...(input.requestedByRecordId ? { requestedByRecordId: input.requestedByRecordId } : {}),
      ...(release ? { releaseId: release.releaseId } : {}),
      summary: denials.length === 0 ? "Package action authorized." : "Package action denied.",
      checks,
      denials
    };
  }

  async executeGovernedPackageAction(
    executor: BoundedExecutorService,
    input: {
      packageId: string;
      requestedByOwnerId: string;
      requestedByRecordId?: string;
      surfaceId?: CapabilitySurfaceId;
      grantEvidence?: CapabilityPackageGrantEvidence;
      payload?: Record<string, unknown>;
    }
  ): Promise<{
    authorization: CapabilityPackageActionAuthorization;
    executorRun: BoundedExecutorRunRecord;
    evidence: CapabilityPackageActionExecutionRecord;
  }> {
    const authorization = await this.authorizePackageAction(input);
    const release = authorization.releaseId
      ? await this.storage.getRecord<CapabilityReleaseRecord>(OWNER_ID, RELEASE_COLLECTION, authorization.releaseId)
      : undefined;
    const permissionDecision: BoundedExecutorPermissionDecision = {
      ok: authorization.ok,
      checkedAt: authorization.checkedAt,
      summary: authorization.summary,
      checks: authorization.checks,
      denials: authorization.denials
    };
    const executorRun = await executor.submit({
      actionKind: "capability.package-action",
      actionId: `package:${input.packageId}:${authorization.releaseId ?? "unpublished"}`,
      requestedByOwnerId: input.requestedByOwnerId,
      ...(input.requestedByRecordId ? { requestedByRecordId: input.requestedByRecordId } : {}),
      environmentId: ENVIRONMENT_ID,
      ownerRefs: [`capability-platform:package:${input.packageId}`],
      permissionDecision,
      input: {
        packageId: input.packageId,
        releaseId: authorization.releaseId ?? "",
        entrypoint: release?.entrypoint ?? "",
        sourceLanguage: release?.sourceLanguage ?? "",
        payload: input.payload ?? {},
        forms: release?.forms ?? {}
      }
    });
    const now = new Date().toISOString();
    const evidence: CapabilityPackageActionExecutionRecord = {
      executionId: randomUUID(),
      packageId: input.packageId,
      ...(authorization.releaseId ? { releaseId: authorization.releaseId } : {}),
      requestedByOwnerId: input.requestedByOwnerId,
      ...(input.requestedByRecordId ? { requestedByRecordId: input.requestedByRecordId } : {}),
      executorRunId: executorRun.runId,
      status:
        executorRun.status === "complete"
          ? "complete"
          : executorRun.status === "denied"
            ? "denied"
            : "failed",
      requestedAt: executorRun.requestedAt,
      updatedAt: now,
      inputSummary: summarizePayload(input.payload ?? {}),
      outputCount: executorRun.outputs.length,
      failureCount: executorRun.failures.length,
      permissionDenials: executorRun.permissionDenials
    };
    await this.storage.putRecord(OWNER_ID, ACTION_EXECUTION_COLLECTION, evidence.executionId, evidence);
    await this.recordPackageEvent(
      input.packageId,
      `package-action-${evidence.status}`,
      `Package action ${evidence.status} for ${input.packageId}.`,
      {
        executionId: evidence.executionId,
        executorRunId: executorRun.runId,
        requestedByOwnerId: input.requestedByOwnerId,
        permissionDenials: evidence.permissionDenials,
        outputCount: evidence.outputCount,
        failureCount: evidence.failureCount
      }
    );
    return {
      authorization,
      executorRun,
      evidence
    };
  }

  async inspectObservability(): Promise<CapabilityPlatformObservability> {
    const [
      packages,
      releases,
      drafts,
      draftItems,
      publications,
      events,
      forms,
      actionExecutions,
      policies,
      sourceRegistrations
    ] = await Promise.all([
      this.listNormalizedPackages(),
      this.storage.listRecords<CapabilityReleaseRecord>(OWNER_ID, RELEASE_COLLECTION),
      this.storage.listRecords<CapabilityDraftRecord>(OWNER_ID, DRAFT_COLLECTION),
      this.storage.listRecords<CapabilityDraftItemRecord>(OWNER_ID, DRAFT_ITEM_COLLECTION),
      this.storage.listRecords<CapabilityPublicationRecord>(OWNER_ID, PUBLICATION_COLLECTION),
      this.storage.listRecords<CapabilityPackageEventRecord>(OWNER_ID, EVENT_COLLECTION),
      this.storage.listRecords<CapabilityPublishedFormRecord>(OWNER_ID, FORM_COLLECTION),
      this.storage.listRecords<CapabilityPackageActionExecutionRecord>(OWNER_ID, ACTION_EXECUTION_COLLECTION),
      this.storage.listRecords<CapabilitySurfacePolicyRecord>(OWNER_ID, POLICY_COLLECTION),
      this.storage.listRecords<CapabilitySourceRegistrationRecord>(OWNER_ID, SOURCE_COLLECTION)
    ]);
    return {
      packageCount: packages.length,
      releaseCount: releases.length,
      publishedCount: packages.filter((pkg) => Boolean(pkg.publishedReleaseId)).length,
      draftCount: drafts.length,
      draftItemCount: draftItems.length,
      publicationCount: publications.length,
      eventCount: events.length,
      publishedFormCount: forms.length,
      surfacePolicyCount: policies.length,
      sourceRegistrationCount: sourceRegistrations.length,
      packageActionExecutionCount: actionExecutions.length,
      gateCount: packages.flatMap((pkg) => pkg.gates).length,
      legacyImportedCount: packages.filter((pkg) => Boolean(pkg.draft.metadata.legacyPromptId)).length,
      storageRoot: this.storage.namespacePath(OWNER_ID),
      packages: packages.map((pkg) => ({
        packageId: pkg.packageId,
        gates: pkg.gates,
        surfaceContracts: pkg.surfaceContracts,
        sourceLanguage: pkg.draft.sourceLanguage,
        ...(pkg.publishedReleaseId ? { publishedReleaseId: pkg.publishedReleaseId } : {}),
        ...(pkg.lifecycleState ? { lifecycleState: pkg.lifecycleState } : {})
      }))
    };
  }

  async importLegacyPromptPackages(legacyDatabaseRoots: string[]): Promise<LegacyCapabilityImportReport> {
    const importedPackages: string[] = [];
    const skippedPackages: string[] = [];
    const rootsUsed = legacyDatabaseRoots.filter(Boolean);

    for (const databaseRoot of rootsUsed) {
      const activeRoot = path.join(databaseRoot, "prompt-truth", "active");
      const promptDirectories = await readdir(activeRoot, { withFileTypes: true }).catch(() => []);
      for (const directory of promptDirectories) {
        if (!directory.isDirectory()) {
          continue;
        }
        const promptPath = path.join(activeRoot, directory.name, "prompt.json");
        const promptRecord = await readJsonFile<LegacyPromptRecord>(promptPath);
        if (!promptRecord) {
          continue;
        }
        const packageId = `cap.prompt.${normalizeLegacyId(promptRecord.promptId)}`;
        const existing = await this.storage.getRecord<CapabilityPackageRecord>(
          OWNER_ID,
          PACKAGE_COLLECTION,
          packageId
        );
        if (existing) {
          skippedPackages.push(packageId);
          continue;
        }
        const now = new Date().toISOString();
        const pkg: CapabilityPackageRecord = {
          packageId,
          createdAt: now,
          updatedAt: now,
          lifecycleState: "draft",
          draft: {
            name: promptRecord.title.trim(),
            description: promptRecord.summary.trim(),
            metadata: {
              owner: "capability-platform",
              legacyPromptId: promptRecord.promptId,
              legacySource: path.relative(databaseRoot, promptPath),
              benchmarkArtifactCount: String(promptRecord.benchmarkArtifacts.length),
              governanceFlags: promptRecord.governanceFlags.join(", ")
            },
            entrypoint: promptRecord.promptId,
            sourceLanguage: "text",
            packageKind: "prompt",
            sourceMode: "legacy-import",
            componentDependencies: [],
            publishOutputs: ["source", "json", "text", "runtime-entrypoint"],
            sourceText: promptRecord.promptText
          },
          gates: ["draft-edit", "publish", "benchmark-inspect", "history-read"],
          surfaceContracts: [
            "unpublished-draft",
            "published-text",
            "published-json",
            "benchmark-artifacts",
            "history"
          ],
          releaseIds: [],
          publicationIds: [],
          eventIds: [],
          policyIds: []
        };
        await this.storage.putRecord(OWNER_ID, PACKAGE_COLLECTION, packageId, pkg);
        await this.ensureLifecycleRecords(pkg);
        importedPackages.push(packageId);
      }
    }

    if (importedPackages.length > 0) {
      await this.recordPackageEvent(
        "capability-platform",
        "legacy-prompts-imported",
        `Imported ${importedPackages.length} legacy prompt package(s) into Capability Platform.`,
        {
          importedPackages,
          rootsUsed
        }
      );
    }

    return {
      rootsUsed,
      importedCount: importedPackages.length,
      skippedCount: skippedPackages.length,
      importedPackages,
      skippedPackages
    };
  }

  private async listNormalizedPackages(): Promise<CapabilityPackageRecord[]> {
    const packages = await this.storage.listRecords<CapabilityPackageRecord>(OWNER_ID, PACKAGE_COLLECTION);
    const normalized = [];
    for (const pkg of packages) {
      normalized.push(await this.ensureLifecycleRecords(pkg));
    }
    return normalized;
  }

  private async ensureLifecycleRecords(pkg: CapabilityPackageRecord): Promise<CapabilityPackageRecord> {
    const normalized = normalizePackageRecord(pkg);
    const [sourceRegistration, policies] = await Promise.all([
      this.ensureSourceRegistration(normalized),
      this.ensureSurfacePolicies(normalized)
    ]);
    const openDraft = await this.ensureOpenDraft({
      ...normalized,
      sourceRegistrationId: sourceRegistration.sourceRegistrationId,
      policyIds: policies.map((policy) => policy.policyId)
    });
    const liveRecord = normalized.publishedReleaseId
      ? await this.ensureLiveRecord(normalized, normalized.publishedReleaseId)
      : undefined;
    const next: CapabilityPackageRecord = {
      ...normalized,
      openDraftId: openDraft.draftId,
      sourceRegistrationId: sourceRegistration.sourceRegistrationId,
      policyIds: policies.map((policy) => policy.policyId),
      ...(liveRecord ? { liveRecordId: liveRecord.liveRecordId } : {})
    };
    await this.storage.putRecord(OWNER_ID, PACKAGE_COLLECTION, next.packageId, next);
    return next;
  }

  private async ensureOpenDraft(pkg: CapabilityPackageRecord): Promise<CapabilityDraftRecord> {
    const now = new Date().toISOString();
    const draftId = pkg.openDraftId ?? `draft:${pkg.packageId}:current`;
    const existing = await this.storage.getRecord<CapabilityDraftRecord>(OWNER_ID, DRAFT_COLLECTION, draftId);
    if (existing) {
      return existing;
    }
    const draft: CapabilityDraftRecord = {
      draftId,
      packageId: pkg.packageId,
      state: "open",
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...(pkg.publishedReleaseId ? { baseReleaseId: pkg.publishedReleaseId } : {}),
      itemIds: []
    };
    await this.storage.putRecord(OWNER_ID, DRAFT_COLLECTION, draftId, draft);
    return draft;
  }

  private async ensureSourceRegistration(
    pkg: CapabilityPackageRecord
  ): Promise<CapabilitySourceRegistrationRecord> {
    const sourceRegistrationId = pkg.sourceRegistrationId ?? `source:${pkg.packageId}`;
    const existing = await this.storage.getRecord<CapabilitySourceRegistrationRecord>(
      OWNER_ID,
      SOURCE_COLLECTION,
      sourceRegistrationId
    );
    const now = new Date().toISOString();
    const record: CapabilitySourceRegistrationRecord = {
      sourceRegistrationId,
      packageId: pkg.packageId,
      sourceMode: pkg.draft.sourceMode ?? inferSourceMode(pkg.draft.metadata),
      sourceLanguage: pkg.draft.sourceLanguage,
      sourceRef: `owner://${OWNER_ID}/packages/${pkg.packageId}/draft`,
      visibility: "owner-local",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await this.storage.putRecord(OWNER_ID, SOURCE_COLLECTION, sourceRegistrationId, record);
    return record;
  }

  private async ensureSurfacePolicies(pkg: CapabilityPackageRecord): Promise<CapabilitySurfacePolicyRecord[]> {
    const now = new Date().toISOString();
    const surfaceIds: CapabilitySurfaceId[] = ["published", "unpublished", "history", "artifact", "policy", "admin"];
    const policies = [];
    for (const surfaceId of surfaceIds) {
      const policyId = `policy:${pkg.packageId}:${surfaceId}`;
      const existing = await this.storage.getRecord<CapabilitySurfacePolicyRecord>(
        OWNER_ID,
        POLICY_COLLECTION,
        policyId
      );
      const policy: CapabilitySurfacePolicyRecord = {
        policyId,
        packageId: pkg.packageId,
        surfaceId,
        access:
          surfaceId === "published" || surfaceId === "history" || surfaceId === "artifact"
            ? "granted-consumers"
            : "owner-only",
        consumers: existing?.consumers ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      await this.storage.putRecord(OWNER_ID, POLICY_COLLECTION, policyId, policy);
      policies.push(policy);
    }
    return policies;
  }

  private async ensureLiveRecord(
    pkg: CapabilityPackageRecord,
    releaseId: string
  ): Promise<CapabilityLiveRecord | undefined> {
    const release = await this.storage.getRecord<CapabilityReleaseRecord>(OWNER_ID, RELEASE_COLLECTION, releaseId);
    if (!release) {
      return undefined;
    }
    const liveRecord: CapabilityLiveRecord = {
      liveRecordId: `live:${pkg.packageId}`,
      packageId: pkg.packageId,
      releaseId,
      version: release.version,
      installedAt: release.publishedAt,
      state: "published",
      surfaceContracts: pkg.surfaceContracts,
      formIds: release.formIds ?? [],
      artifactIds: release.artifactIds ?? []
    };
    await this.storage.putRecord(OWNER_ID, LIVE_COLLECTION, liveRecord.liveRecordId, liveRecord);
    return liveRecord;
  }

  private async publishSnapshot(input: {
    pkg: CapabilityPackageRecord;
    validation: CapabilityValidationResult;
    snapshot: CapabilityDraftSurface;
    summary: string;
    draftId?: string;
    rollbackOfReleaseId?: string;
  }): Promise<CapabilityReleaseRecord> {
    const now = new Date().toISOString();
    const releaseId = randomUUID();
    const version = input.pkg.releaseIds.length + 1;
    const outputFormKinds = normalizeOutputKinds(input.snapshot.publishOutputs);
    const candidate: CapabilityPublicationCandidateRecord = {
      candidateId: randomUUID(),
      packageId: input.pkg.packageId,
      ...(input.draftId ? { draftId: input.draftId } : {}),
      createdAt: now,
      version,
      publishable: input.validation.ok,
      validation: input.validation,
      outputFormKinds,
      snapshot: {
        draft: input.snapshot,
        gates: input.pkg.gates,
        surfaceContracts: input.pkg.surfaceContracts
      }
    };
    await this.storage.putRecord(OWNER_ID, CANDIDATE_COLLECTION, candidate.candidateId, candidate);

    const derivedForms = derivePublishedForms(input.pkg.packageId, releaseId, input.snapshot);
    const publishedForms: CapabilityPublishedFormRecord[] = [];
    const artifactIds: string[] = [];
    for (const formKind of outputFormKinds) {
      const artifact = await this.storage.putArtifact({
        ownerId: OWNER_ID,
        artifactId: `${input.pkg.packageId}/${releaseId}/${formKind}`,
        mediaType: mediaTypeForForm(formKind),
        body: derivedForms[formKind],
        metadata: {
          packageId: input.pkg.packageId,
          releaseId,
          formKind,
          executorBoundaryRequired: "true"
        }
      });
      const form: CapabilityPublishedFormRecord = {
        formId: `form:${releaseId}:${formKind}`,
        packageId: input.pkg.packageId,
        releaseId,
        formKind,
        artifactId: artifact.artifactId,
        mediaType: artifact.mediaType,
        storagePath: artifact.path,
        createdAt: now,
        metadata: artifact.metadata
      };
      await this.storage.putRecord(OWNER_ID, FORM_COLLECTION, form.formId, form);
      artifactIds.push(artifact.artifactId);
      publishedForms.push(form);
    }

    const release: CapabilityReleaseRecord = {
      releaseId,
      packageId: input.pkg.packageId,
      version,
      publishedAt: now,
      entrypoint: input.snapshot.entrypoint,
      sourceLanguage: input.snapshot.sourceLanguage,
      validation: input.validation,
      candidateId: candidate.candidateId,
      ...(input.rollbackOfReleaseId ? { rollbackOfReleaseId: input.rollbackOfReleaseId } : {}),
      artifactIds,
      formIds: publishedForms.map((form) => form.formId),
      forms: {
        source: derivedForms.source,
        json: derivedForms.json,
        text: derivedForms.text,
        runtimeEntrypoint: derivedForms["runtime-entrypoint"]
      }
    };
    await this.storage.putRecord(OWNER_ID, RELEASE_COLLECTION, releaseId, release);

    const publication: CapabilityPublicationRecord = {
      publicationId: randomUUID(),
      packageId: input.pkg.packageId,
      releaseId,
      candidateId: candidate.candidateId,
      version,
      publishedAt: now,
      summary: input.summary,
      state: "published",
      ...(input.pkg.publishedReleaseId ? { replacedReleaseId: input.pkg.publishedReleaseId } : {}),
      ...(input.rollbackOfReleaseId ? { rollbackOfReleaseId: input.rollbackOfReleaseId } : {}),
      formIds: release.formIds ?? [],
      artifactIds
    };
    await this.storage.putRecord(OWNER_ID, PUBLICATION_COLLECTION, publication.publicationId, publication);

    const liveRecord: CapabilityLiveRecord = {
      liveRecordId: `live:${input.pkg.packageId}`,
      packageId: input.pkg.packageId,
      releaseId,
      version,
      installedAt: now,
      state: "published",
      surfaceContracts: input.pkg.surfaceContracts,
      formIds: release.formIds ?? [],
      artifactIds
    };
    await this.storage.putRecord(OWNER_ID, LIVE_COLLECTION, liveRecord.liveRecordId, liveRecord);

    if (input.draftId) {
      const draft = await this.storage.getRecord<CapabilityDraftRecord>(OWNER_ID, DRAFT_COLLECTION, input.draftId);
      if (draft) {
        await this.storage.putRecord(OWNER_ID, DRAFT_COLLECTION, input.draftId, {
          ...draft,
          state: "published",
          updatedAt: now,
          validation: input.validation
        } satisfies CapabilityDraftRecord);
      }
    }

    const nextPackage: CapabilityPackageRecord = {
      ...input.pkg,
      updatedAt: now,
      lifecycleState: "published",
      liveRecordId: liveRecord.liveRecordId,
      draft: input.snapshot,
      draftValidation: input.validation,
      publishedReleaseId: releaseId,
      releaseIds: [...input.pkg.releaseIds, releaseId],
      publicationIds: [...(input.pkg.publicationIds ?? []), publication.publicationId]
    };
    await this.storage.putRecord(OWNER_ID, PACKAGE_COLLECTION, input.pkg.packageId, nextPackage);
    await this.recordPackageEvent(
      input.pkg.packageId,
      input.rollbackOfReleaseId ? "rolled-back-by-publication" : "published",
      input.rollbackOfReleaseId
        ? `Republished ${input.pkg.packageId} from release ${input.rollbackOfReleaseId} as v${version}.`
        : `Published ${input.pkg.packageId} as release v${version}.`,
      {
        releaseId,
        version,
        candidateId: candidate.candidateId,
        publicationId: publication.publicationId,
        formIds: release.formIds,
        artifactIds,
        ...(input.rollbackOfReleaseId ? { rollbackOfReleaseId: input.rollbackOfReleaseId } : {})
      }
    );
    return release;
  }

  private async recordPackageEvent(
    packageId: string,
    type: string,
    summary: string,
    details?: Record<string, unknown>
  ): Promise<CapabilityPackageEventRecord> {
    const event: CapabilityPackageEventRecord = {
      eventId: randomUUID(),
      packageId,
      type,
      summary,
      createdAt: new Date().toISOString(),
      ...(details ? { details } : {})
    };
    await this.storage.putRecord(OWNER_ID, EVENT_COLLECTION, event.eventId, event);
    await this.storage.appendEvent(OWNER_ID, EVENT_STREAM, {
      eventId: event.eventId,
      ownerId: OWNER_ID,
      stream: EVENT_STREAM,
      type,
      summary,
      ...(details ? { details } : {}),
      createdAt: event.createdAt
    });
    await this.coordination.recordEvent({
      ownerId: OWNER_ID,
      type,
      summary,
      ...(details ? { details } : {})
    });
    return event;
  }

  private async requirePackage(packageId: string): Promise<CapabilityPackageRecord> {
    const pkg = await this.storage.getRecord<CapabilityPackageRecord>(OWNER_ID, PACKAGE_COLLECTION, packageId);
    if (!pkg) {
      throw new Error(`Capability package ${packageId} was not found.`);
    }
    return pkg;
  }
}

function validateDraft(
  pkg: CapabilityPackageRecord,
  allPackages: CapabilityPackageRecord[]
): CapabilityValidationResult {
  const issues: string[] = [];
  if (!pkg.draft.name.trim()) {
    issues.push("Package name is required.");
  }
  if (!pkg.draft.description.trim()) {
    issues.push("Package description is required.");
  }
  if (!pkg.draft.entrypoint.trim()) {
    issues.push("Declared entrypoint is required.");
  }
  if (!pkg.draft.sourceText.trim()) {
    issues.push("Unpublished source text is required.");
  }
  if (!pkg.surfaceContracts.length) {
    issues.push("At least one package surface contract must be declared.");
  }
  const duplicateIds = allPackages.filter((candidate) => candidate.packageId === pkg.packageId);
  if (duplicateIds.length > 1) {
    issues.push(`Package id ${pkg.packageId} is duplicated in Capability Platform custody.`);
  }
  for (const dependency of pkg.draft.componentDependencies ?? []) {
    if (dependency === pkg.packageId) {
      issues.push("A capability package cannot depend on itself.");
      continue;
    }
    const dependencyPackage = allPackages.find((candidate) => candidate.packageId === dependency);
    if (!dependencyPackage) {
      issues.push(`Component dependency ${dependency} is not registered.`);
      continue;
    }
    if (!dependencyPackage.publishedReleaseId) {
      issues.push(`Component dependency ${dependency} is not published.`);
    }
  }
  const runtimeHint = `${pkg.draft.metadata.runtime ?? ""} ${pkg.draft.metadata.executionMode ?? ""}`.toLowerCase();
  if (runtimeHint.includes("fastapi") || runtimeHint.includes("direct")) {
    issues.push("Runtime metadata must target Skeleton's executor boundary, not a direct RevEng runtime path.");
  }
  return {
    checkedAt: new Date().toISOString(),
    ok: issues.length === 0,
    summary:
      issues.length === 0
        ? "Draft truth is structurally valid for publish through the Capability Platform lifecycle."
        : "Draft truth is missing required package lifecycle data or violates publish policy.",
    issues
  };
}

function normalizePackageRecord(pkg: CapabilityPackageRecord): CapabilityPackageRecord {
  const draft = normalizeDraftSurface(pkg.draft);
  return {
    ...pkg,
    lifecycleState: pkg.lifecycleState ?? (pkg.publishedReleaseId ? "published" : "draft"),
    draft,
    gates: pkg.gates ?? [],
    surfaceContracts: pkg.surfaceContracts?.length
      ? pkg.surfaceContracts
      : ["unpublished-draft", "published-source", "published-json", "history"],
    releaseIds: pkg.releaseIds ?? [],
    publicationIds: pkg.publicationIds ?? [],
    eventIds: pkg.eventIds ?? [],
    policyIds: pkg.policyIds ?? []
  };
}

function normalizeDraftSurface(draft: CapabilityDraftSurface): CapabilityDraftSurface {
  const sourceLanguage = normalizeSourceLanguage(draft.sourceLanguage);
  return {
    name: draft.name ?? "",
    description: draft.description ?? "",
    metadata: normalizeStringRecord(draft.metadata),
    entrypoint: draft.entrypoint ?? "",
    sourceLanguage,
    packageKind: draft.packageKind ?? inferPackageKind(sourceLanguage),
    sourceMode: draft.sourceMode ?? inferSourceMode(draft.metadata),
    componentDependencies: draft.componentDependencies ?? [],
    publishOutputs: normalizeOutputKinds(draft.publishOutputs),
    sourceText: draft.sourceText ?? ""
  };
}

function derivePublishedForms(
  packageId: string,
  releaseId: string,
  draft: CapabilityDraftSurface
): Record<CapabilityPublishedFormKind, string> {
  const contract = {
    packageId,
    releaseId,
    name: draft.name,
    description: draft.description,
    metadata: draft.metadata,
    entrypoint: draft.entrypoint,
    sourceLanguage: draft.sourceLanguage,
    packageKind: draft.packageKind,
    sourceMode: draft.sourceMode,
    componentDependencies: draft.componentDependencies ?? [],
    publishOutputs: normalizeOutputKinds(draft.publishOutputs)
  };
  return {
    source: draft.sourceText,
    json: JSON.stringify(contract, null, 2),
    text: [
      draft.name,
      "",
      draft.description,
      "",
      `Entrypoint: ${draft.entrypoint}`,
      `Package kind: ${draft.packageKind ?? inferPackageKind(draft.sourceLanguage)}`,
      "Executor boundary required before runtime invocation."
    ].join("\n"),
    "runtime-entrypoint": JSON.stringify(
      {
        packageId,
        releaseId,
        entrypoint: draft.entrypoint,
        sourceLanguage: draft.sourceLanguage,
        executorBoundaryRequired: true,
        directExecutionAllowed: false
      },
      null,
      2
    )
  };
}

function draftSurfaceFromRelease(
  pkg: CapabilityPackageRecord,
  release: CapabilityReleaseRecord
): CapabilityDraftSurface {
  const parsed = parsePublishedJson(release.forms.json);
  return {
    ...pkg.draft,
    name: parsed?.name ?? pkg.draft.name,
    description: parsed?.description ?? pkg.draft.description,
    metadata: normalizeStringRecord(parsed?.metadata ?? pkg.draft.metadata),
    entrypoint: parsed?.entrypoint ?? release.entrypoint,
    sourceLanguage: normalizeSourceLanguage(parsed?.sourceLanguage ?? release.sourceLanguage),
    packageKind: parsed?.packageKind ?? pkg.draft.packageKind ?? inferPackageKind(release.sourceLanguage),
    sourceMode: parsed?.sourceMode ?? pkg.draft.sourceMode ?? "authored",
    componentDependencies: Array.isArray(parsed?.componentDependencies)
      ? parsed.componentDependencies.map(String)
      : pkg.draft.componentDependencies ?? [],
    publishOutputs: normalizeOutputKinds(parsed?.publishOutputs ?? pkg.draft.publishOutputs),
    sourceText: release.forms.source
  };
}

function parsePublishedJson(raw: string): Partial<CapabilityDraftSurface> | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<CapabilityDraftSurface>;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readJsonFile<T>(target: string): Promise<T | undefined> {
  try {
    const raw = await readFile(target, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function normalizeLegacyId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-");
}

function summarizePayload(payload: Record<string, unknown>): string {
  const raw = JSON.stringify(payload);
  return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
}

function normalizeStringRecord(input?: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input ?? {}).map(([key, value]) => [key, String(value)])
  );
}

function normalizeSourceLanguage(value: string | undefined): CapabilitySourceLanguage {
  return value === "python" ? "python" : "text";
}

function inferPackageKind(sourceLanguage: CapabilitySourceLanguage): CapabilityDraftSurface["packageKind"] {
  return sourceLanguage === "python" ? "function" : "prompt";
}

function inferSourceMode(metadata?: Record<string, unknown>): CapabilitySourceMode {
  if (metadata?.legacyPromptId) {
    return "legacy-import";
  }
  if (metadata?.sourceMode === "external-registration") {
    return "external-registration";
  }
  if (metadata?.sourceMode === "authored") {
    return "authored";
  }
  return "system-bootstrap";
}

function normalizeOutputKinds(input?: CapabilityPublishedFormKind[]): CapabilityPublishedFormKind[] {
  const allowed: CapabilityPublishedFormKind[] = ["source", "json", "text", "runtime-entrypoint"];
  const selected = (input ?? allowed).filter((kind): kind is CapabilityPublishedFormKind =>
    allowed.includes(kind as CapabilityPublishedFormKind)
  );
  return selected.length > 0 ? Array.from(new Set(selected)) : allowed;
}

function mediaTypeForForm(formKind: CapabilityPublishedFormKind): string {
  if (formKind === "json" || formKind === "runtime-entrypoint") {
    return "application/json";
  }
  return "text/plain";
}
