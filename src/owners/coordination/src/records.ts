export interface CoordinationEventRecord {
  eventId: string;
  ownerId: string;
  type: string;
  summary: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowStepRecord {
  stepId: string;
  label: string;
  dispatchMode: string;
  onSuccess: string;
  onFailure: string;
  requiresUserAction: boolean;
}

export interface WorkflowDefinitionRecord {
  workflowId: string;
  label: string;
  version: string;
  entryStepId: string;
  executionPolicy: string;
  stepCount: number;
  steps: WorkflowStepRecord[];
}

export interface ChangeSessionSummary {
  sessionId: string;
  title: string;
  repoTarget: string;
  currentPhase: string;
  currentStatus: string;
  updatedAt: string;
  workflowId: string;
  workflowLabel: string;
  discussionSummary: string;
}

export interface ChangeSessionDetail extends ChangeSessionSummary {
  intentSummary: string;
  assumptions: string[];
  constraints: string[];
  scopeNotes: string[];
  changedFiles: string[];
  validationOutputs: string[];
  reviewWarnings: string[];
  unresolvedIssues: string[];
  recommendedNextStep: string;
  eventCount: number;
  invocationCount: number;
  auditStatus: string;
}

export interface LegacyCoordinationImportReport {
  rootsUsed: string[];
  importedWorkflows: string[];
  importedSessions: string[];
}

export interface CoordinationObservability {
  storageRoot: string;
  eventCount: number;
  workflowCount: number;
  sessionCount: number;
  ownerCounts: Array<{
    ownerId: string;
    count: number;
  }>;
  typeCounts: Array<{
    type: string;
    count: number;
  }>;
  recentEvents: CoordinationEventRecord[];
}
