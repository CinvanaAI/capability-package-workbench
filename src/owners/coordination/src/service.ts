import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { StorageSubstrateService } from "../../storage/src/service.js";
import type {
  ChangeSessionDetail,
  ChangeSessionSummary,
  CoordinationEventRecord,
  CoordinationObservability,
  LegacyCoordinationImportReport,
  WorkflowDefinitionRecord
} from "./records.js";

const OWNER_ID = "coordination";
const STREAM = "handoffs";
const WORKFLOW_COLLECTION = "workflow-definitions";
const SESSION_COLLECTION = "change-sessions";

interface LegacyWorkflowDefinition {
  workflowId: string;
  label: string;
  version: string;
  entryStepId: string;
  executionPolicy: string;
  steps: Array<{
    stepId: string;
    label: string;
    dispatchMode: string;
    onSuccess: string;
    onFailure: string;
    requiresUserAction?: boolean;
  }>;
}

interface LegacyChangeSession {
  sessionId: string;
  title: string;
  repoTarget: string;
  updatedAt: string;
  currentPhase: string;
  currentStatus: string;
  discussionSummary?: string;
  intent?: {
    currentIntentSummary?: string;
    assumptions?: string[];
    constraints?: string[];
    scopeNotes?: string[];
  };
  executionRun?: {
    changedFiles?: string[];
    validationOutputs?: string[];
  };
  review?: {
    gptReviewWarnings?: string[];
  };
  audit?: {
    auditRun?: {
      status?: string;
    };
  };
  resolution?: {
    unresolvedIssues?: string[];
    recommendedNextStep?: string;
  };
}

export class CoordinationLayerService {
  constructor(private readonly storage: StorageSubstrateService) {}

  async recordEvent(input: {
    ownerId: string;
    type: string;
    summary: string;
    details?: Record<string, unknown>;
  }): Promise<CoordinationEventRecord> {
    const event: CoordinationEventRecord = {
      eventId: randomUUID(),
      ownerId: input.ownerId,
      type: input.type,
      summary: input.summary,
      ...(input.details ? { details: input.details } : {}),
      createdAt: new Date().toISOString()
    };
    await this.storage.appendEvent(OWNER_ID, STREAM, {
      ...event,
      stream: STREAM
    });
    return event;
  }

  async listRecent(limit = 20): Promise<CoordinationEventRecord[]> {
    const events = await this.storage.listEvents(OWNER_ID, STREAM, limit);
    return events.map((event) => ({
      eventId: event.eventId,
      ownerId: event.ownerId,
      type: event.type,
      summary: event.summary,
      ...(event.details ? { details: event.details } : {}),
      createdAt: event.createdAt
    }));
  }

  async listWorkflows(): Promise<WorkflowDefinitionRecord[]> {
    return this.storage.listRecords(OWNER_ID, WORKFLOW_COLLECTION);
  }

  async listChangeSessions(): Promise<ChangeSessionSummary[]> {
    const sessions = await this.storage.listRecords<ChangeSessionDetail>(OWNER_ID, SESSION_COLLECTION);
    return sessions
      .map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        repoTarget: session.repoTarget,
        currentPhase: session.currentPhase,
        currentStatus: session.currentStatus,
        updatedAt: session.updatedAt,
        workflowId: session.workflowId,
        workflowLabel: session.workflowLabel,
        discussionSummary: session.discussionSummary
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getChangeSession(sessionId: string): Promise<ChangeSessionDetail | undefined> {
    return this.storage.getRecord(OWNER_ID, SESSION_COLLECTION, sessionId);
  }

  async importLegacyChangeWorkflows(legacyDatabaseRoots: string[]): Promise<LegacyCoordinationImportReport> {
    const importedWorkflows = new Set<string>();
    const importedSessions = new Set<string>();

    for (const databaseRoot of legacyDatabaseRoots.filter(Boolean)) {
      const workflowRoot = path.join(databaseRoot, "workflow-truth");
      const workflowFiles = await readdir(workflowRoot, { withFileTypes: true }).catch(() => []);
      for (const workflowFile of workflowFiles) {
        if (!workflowFile.isFile() || !workflowFile.name.endsWith(".json")) {
          continue;
        }
        const workflow = await readJsonFile<LegacyWorkflowDefinition>(
          path.join(workflowRoot, workflowFile.name)
        );
        if (!workflow?.workflowId) {
          continue;
        }
        const record: WorkflowDefinitionRecord = {
          workflowId: workflow.workflowId,
          label: workflow.label,
          version: workflow.version,
          entryStepId: workflow.entryStepId,
          executionPolicy: workflow.executionPolicy,
          stepCount: workflow.steps.length,
          steps: workflow.steps.map((step) => ({
            stepId: step.stepId,
            label: step.label,
            dispatchMode: step.dispatchMode,
            onSuccess: step.onSuccess,
            onFailure: step.onFailure,
            requiresUserAction: Boolean(step.requiresUserAction)
          }))
        };
        await this.storage.putRecord(OWNER_ID, WORKFLOW_COLLECTION, record.workflowId, record);
        importedWorkflows.add(record.workflowId);
      }

      const workflows = await this.listWorkflows();
      const workflow = workflows.find((item) => item.workflowId === "change-workflow") ?? workflows[0];
      const sessionsRoot = path.join(databaseRoot, "change-sessions");
      const sessionDirectories = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
      for (const directory of sessionDirectories) {
        if (!directory.isDirectory() || directory.name.startsWith("_")) {
          continue;
        }
        const sessionRoot = path.join(sessionsRoot, directory.name);
        const session = await readJsonFile<LegacyChangeSession>(path.join(sessionRoot, "session.json"));
        if (!session?.sessionId) {
          continue;
        }
        const events = await readJsonFile<Array<unknown>>(path.join(sessionRoot, "events.json"));
        const invocations = await readJsonFile<Array<unknown>>(path.join(sessionRoot, "invocations.json"));
        const detail: ChangeSessionDetail = {
          sessionId: session.sessionId,
          title: session.title,
          repoTarget: session.repoTarget,
          currentPhase: session.currentPhase,
          currentStatus: session.currentStatus,
          updatedAt: session.updatedAt,
          workflowId: workflow?.workflowId ?? "change-workflow",
          workflowLabel: workflow?.label ?? "Change Workflow",
          discussionSummary: session.discussionSummary ?? "",
          intentSummary: session.intent?.currentIntentSummary ?? "",
          assumptions: session.intent?.assumptions ?? [],
          constraints: session.intent?.constraints ?? [],
          scopeNotes: session.intent?.scopeNotes ?? [],
          changedFiles: session.executionRun?.changedFiles ?? [],
          validationOutputs: session.executionRun?.validationOutputs ?? [],
          reviewWarnings: session.review?.gptReviewWarnings ?? [],
          unresolvedIssues: session.resolution?.unresolvedIssues ?? [],
          recommendedNextStep: session.resolution?.recommendedNextStep ?? "",
          eventCount: Array.isArray(events) ? events.length : 0,
          invocationCount: Array.isArray(invocations) ? invocations.length : 0,
          auditStatus: session.audit?.auditRun?.status ?? "UNKNOWN"
        };
        await this.storage.putRecord(OWNER_ID, SESSION_COLLECTION, detail.sessionId, detail);
        importedSessions.add(detail.sessionId);
      }
    }

    if (importedWorkflows.size > 0 || importedSessions.size > 0) {
      await this.recordEvent({
        ownerId: OWNER_ID,
        type: "legacy-change-imported",
        summary: `Imported ${importedWorkflows.size} workflow(s) and ${importedSessions.size} change session(s).`,
        details: {
          importedWorkflows: Array.from(importedWorkflows),
          importedSessions: Array.from(importedSessions)
        }
      });
    }

    return {
      rootsUsed: legacyDatabaseRoots.filter(Boolean),
      importedWorkflows: Array.from(importedWorkflows).sort(),
      importedSessions: Array.from(importedSessions).sort()
    };
  }

  async inspectObservability(limit = 50): Promise<CoordinationObservability> {
    const [events, workflows, sessions] = await Promise.all([
      this.storage.listEvents(OWNER_ID, STREAM, limit),
      this.listWorkflows(),
      this.listChangeSessions()
    ]);
    const ownerCounts = new Map<string, number>();
    const typeCounts = new Map<string, number>();
    const recentEvents = events.map((event) => ({
      eventId: event.eventId,
      ownerId: event.ownerId,
      type: event.type,
      summary: event.summary,
      ...(event.details ? { details: event.details } : {}),
      createdAt: event.createdAt
    }));

    for (const event of recentEvents) {
      ownerCounts.set(event.ownerId, (ownerCounts.get(event.ownerId) ?? 0) + 1);
      typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1);
    }

    return {
      storageRoot: this.storage.namespacePath(OWNER_ID),
      eventCount: recentEvents.length,
      workflowCount: workflows.length,
      sessionCount: sessions.length,
      ownerCounts: Array.from(ownerCounts.entries())
        .map(([ownerId, count]) => ({ ownerId, count }))
        .sort((left, right) => right.count - left.count || left.ownerId.localeCompare(right.ownerId)),
      typeCounts: Array.from(typeCounts.entries())
        .map(([type, count]) => ({ type, count }))
        .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type)),
      recentEvents
    };
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
