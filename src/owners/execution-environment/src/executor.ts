import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StorageSubstrateService } from "../../storage/src/service.js";
import type {
  BoundedExecutorObservability,
  BoundedExecutorOutputRecord,
  BoundedExecutorRunRecord,
  BoundedExecutorSubmission
} from "./records.js";

const OWNER_ID = "execution-environment";
const RUN_COLLECTION = "bounded-executor-runs";
const EVENT_STREAM = "bounded-executor";

const CAPABILITY_OWNER_ID = "capability-platform";
const CAPABILITY_LIVE_COLLECTION = "live-records";
const CAPABILITY_RELEASE_COLLECTION = "releases";

interface CapabilityLiveRecord {
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

interface CapabilityReleaseRecord {
  releaseId: string;
  packageId: string;
  version: number;
  publishedAt: string;
  entrypoint: string;
  sourceLanguage: "python" | "text";
  validation: {
    checkedAt: string;
    ok: boolean;
    summary: string;
    issues: string[];
  };
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

interface PythonExecutionResult {
  output: unknown;
  stdout: string;
  stderr: string;
}

export class BoundedExecutorService {
  constructor(private readonly storage: StorageSubstrateService) {}

  async submit(input: BoundedExecutorSubmission): Promise<BoundedExecutorRunRecord> {
    const now = new Date().toISOString();
    const run: BoundedExecutorRunRecord = {
      runId: randomUUID(),
      actionKind: input.actionKind,
      actionId: input.actionId,
      requestedByOwnerId: input.requestedByOwnerId,
      ...(input.requestedByRecordId ? { requestedByRecordId: input.requestedByRecordId } : {}),
      environmentId: input.environmentId,
      ownerRefs: input.ownerRefs,
      status: input.permissionDecision.ok ? "queued" : "denied",
      requestedAt: now,
      updatedAt: now,
      permissionDecision: input.permissionDecision,
      events: [
        {
          at: now,
          type: "submitted",
          summary: `Bounded executor received ${input.actionKind} action ${input.actionId}.`
        }
      ],
      outputs: [],
      failures: [],
      permissionDenials: input.permissionDecision.denials,
      input: input.input
    };

    if (!input.permissionDecision.ok) {
      const denied = {
        ...run,
        completedAt: now,
        updatedAt: now,
        events: [
          ...run.events,
          {
            at: now,
            type: "permission-denied",
            summary: input.permissionDecision.summary,
            details: {
              denials: input.permissionDecision.denials
            }
          }
        ]
      } satisfies BoundedExecutorRunRecord;
      await this.persistRun(denied);
      return denied;
    }

    const running = {
      ...run,
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [
        ...run.events,
        {
          at: new Date().toISOString(),
          type: "running",
          summary: "Bounded executor started the authorized action."
        }
      ]
    } satisfies BoundedExecutorRunRecord;
    await this.persistRun(running);

    try {
      const outputs = await this.runBoundedAction(input);
      const completedAt = new Date().toISOString();
      const complete = {
        ...running,
        status: "complete",
        completedAt,
        updatedAt: completedAt,
        outputs,
        events: [
          ...running.events,
          {
            at: completedAt,
            type: "complete",
            summary: `Bounded executor completed ${input.actionKind} action ${input.actionId}.`,
            details: {
              outputCount: outputs.length
            }
          }
        ]
      } satisfies BoundedExecutorRunRecord;
      await this.persistRun(complete);
      return complete;
    } catch (error) {
      const failedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const failed = {
        ...running,
        status: "failed",
        completedAt: failedAt,
        updatedAt: failedAt,
        failures: [
          {
            at: failedAt,
            summary: message
          }
        ],
        events: [
          ...running.events,
          {
            at: failedAt,
            type: "failed",
            summary: message
          }
        ]
      } satisfies BoundedExecutorRunRecord;
      await this.persistRun(failed);
      return failed;
    }
  }

  async getRun(runId: string): Promise<BoundedExecutorRunRecord | undefined> {
    return this.storage.getRecord(OWNER_ID, RUN_COLLECTION, runId);
  }

  async listRuns(limit = 50): Promise<BoundedExecutorRunRecord[]> {
    const runs = await this.storage.listRecords<BoundedExecutorRunRecord>(OWNER_ID, RUN_COLLECTION);
    return runs
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  async inspectObservability(): Promise<BoundedExecutorObservability> {
    const recentRuns = await this.listRuns(25);
    const allRuns = await this.storage.listRecords<BoundedExecutorRunRecord>(OWNER_ID, RUN_COLLECTION);
    return {
      runCount: allRuns.length,
      completeCount: allRuns.filter((run) => run.status === "complete").length,
      failedCount: allRuns.filter((run) => run.status === "failed").length,
      deniedCount: allRuns.filter((run) => run.status === "denied").length,
      runningCount: allRuns.filter((run) => run.status === "running" || run.status === "queued").length,
      recentRuns
    };
  }

  private async runBoundedAction(input: BoundedExecutorSubmission): Promise<BoundedExecutorOutputRecord[]> {
    if (input.actionKind === "agent.workflow") {
      return this.runAgentWorkflow(input);
    }

    if (input.actionKind === "capability.package-action") {
      return this.runCapabilityPackageAction(input);
    }

    throw new Error(`No bounded action handler is registered for ${input.actionKind}.`);
  }

  private async runAgentWorkflow(input: BoundedExecutorSubmission): Promise<BoundedExecutorOutputRecord[]> {
    const packageIds = arrayFrom(input.input.packages).map(String).filter(Boolean);
    const outputs: BoundedExecutorOutputRecord[] = [
      makeOutput("workflow-summary", "Workflow Summary", {
        actionId: input.actionId,
        workflowLabel: stringFrom(input.input.workflowLabel),
        instruction: stringFrom(input.input.instruction),
        targetCount: arrayFrom(input.input.targets).length,
        packageCount: packageIds.length,
        executedBy: "Skeleton bounded executor"
      }),
      makeOutput("workflow-targets", "Workflow Targets", {
        targets: arrayFrom(input.input.targets)
      })
    ];

    if (packageIds.length === 0) {
      return outputs;
    }

    const payload = objectFrom(input.input.payload);
    const targetPayload = {
      ...payload,
      targets: arrayFrom(input.input.targets),
      workflowLabel: stringFrom(input.input.workflowLabel),
      instruction: stringFrom(input.input.instruction)
    };

    for (const packageId of packageIds) {
      const release = await this.resolvePublishedRelease(packageId);
      const execution = await this.executePythonPackage({
        packageId,
        entrypoint: release.entrypoint,
        sourceText: release.forms.source,
        payload: targetPayload
      });

      outputs.push(
        makeOutput(`package:${packageId}:result`, `Package Result: ${packageId}`, {
          packageId,
          entrypoint: release.entrypoint,
          output: execution.output
        })
      );

      if (execution.stdout.trim()) {
        outputs.push(
          makeOutput(`package:${packageId}:stdout`, `Package Stdout: ${packageId}`, {
            packageId,
            stdout: execution.stdout
          })
        );
      }

      if (execution.stderr.trim()) {
        outputs.push(
          makeOutput(`package:${packageId}:stderr`, `Package Stderr: ${packageId}`, {
            packageId,
            stderr: execution.stderr
          })
        );
      }
    }

    return outputs;
  }

  private async runCapabilityPackageAction(
    input: BoundedExecutorSubmission
  ): Promise<BoundedExecutorOutputRecord[]> {
    const packageId = stringFrom(input.input.packageId);
    const releaseId = stringFrom(input.input.releaseId);
    const entrypoint = stringFrom(input.input.entrypoint);
    const sourceLanguage = stringFrom(input.input.sourceLanguage);
    const payload = objectFrom(input.input.payload);
    const forms = objectFrom(input.input.forms);

    if (sourceLanguage && sourceLanguage !== "python") {
      throw new Error(`Only python capability packages are currently executable. Received: ${sourceLanguage}`);
    }

    let sourceText = stringFrom(forms.source);
    let resolvedEntrypoint = entrypoint;
    let resolvedReleaseId = releaseId;

    if (!sourceText) {
      const release = packageId
        ? await this.resolvePublishedRelease(packageId)
        : releaseId
          ? await this.resolveReleaseById(releaseId)
          : undefined;

      if (!release) {
        throw new Error("Capability package action did not include executable source or a resolvable published release.");
      }

      sourceText = release.forms.source;
      resolvedEntrypoint = resolvedEntrypoint || release.entrypoint;
      resolvedReleaseId = resolvedReleaseId || release.releaseId;
    }

    if (!sourceText.trim()) {
      throw new Error(`Published source for ${packageId || resolvedReleaseId || "package"} is empty.`);
    }

    if (!resolvedEntrypoint) {
      throw new Error(`No entrypoint was supplied for ${packageId || resolvedReleaseId || "package"}.`);
    }

    const execution = await this.executePythonPackage({
      packageId,
      entrypoint: resolvedEntrypoint,
      sourceText,
      payload
    });

    const outputs: BoundedExecutorOutputRecord[] = [
      makeOutput("package-result", "Package Result", {
        packageId,
        releaseId: resolvedReleaseId,
        entrypoint: resolvedEntrypoint,
        output: execution.output
      })
    ];

    if (execution.stdout.trim()) {
      outputs.push(
        makeOutput("package-stdout", "Package Stdout", {
          stdout: execution.stdout
        })
      );
    }

    if (execution.stderr.trim()) {
      outputs.push(
        makeOutput("package-stderr", "Package Stderr", {
          stderr: execution.stderr
        })
      );
    }

    return outputs;
  }

  private async executePythonPackage(input: {
    packageId?: string;
    entrypoint: string;
    sourceText: string;
    payload: Record<string, unknown>;
  }): Promise<PythonExecutionResult> {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "skeleton-bounded-executor-"));
    const scriptPath = path.join(tempRoot, "bounded_package.py");

    const harness = [
      input.sourceText.trimEnd(),
      "",
      "import json",
      "",
      "__SKELETON_PAYLOAD = json.loads(r'''"+escapeForTripleSingleQuotedString(JSON.stringify(input.payload))+"''')",
      `__SKELETON_ENTRYPOINT = ${JSON.stringify(input.entrypoint)}`,
      "",
      "if __SKELETON_ENTRYPOINT not in globals():",
      "    raise RuntimeError(f\"Package entrypoint {__SKELETON_ENTRYPOINT} was not defined by the published source.\")",
      "",
      "__SKELETON_FUNCTION = globals()[__SKELETON_ENTRYPOINT]",
      "",
      "if not callable(__SKELETON_FUNCTION):",
      "    raise RuntimeError(f\"Package entrypoint {__SKELETON_ENTRYPOINT} is not callable.\")",
      "",
      "if isinstance(__SKELETON_PAYLOAD, dict):",
      "    __SKELETON_RESULT = __SKELETON_FUNCTION(**__SKELETON_PAYLOAD)",
      "else:",
      "    __SKELETON_RESULT = __SKELETON_FUNCTION(__SKELETON_PAYLOAD)",
      "",
      "def __skeleton_json_default(value):",
      "    if hasattr(value, 'as_posix') and callable(value.as_posix):",
      "        return value.as_posix()",
      "    return repr(value)",
      "",
      "print('__SKELETON_RESULT__' + json.dumps(__SKELETON_RESULT, default=__skeleton_json_default))"
    ].join("\n");

    await writeFile(scriptPath, `${harness}\n`, "utf8");

    try {
      const invocation = await this.runPythonScript(scriptPath);
      const markerLine = invocation.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith("__SKELETON_RESULT__"));

      if (!markerLine) {
        throw new Error(
          [
            `Python package ${input.packageId || input.entrypoint} did not emit a structured result.`,
            invocation.stdout.trim() ? `stdout:\n${invocation.stdout.trim()}` : "",
            invocation.stderr.trim() ? `stderr:\n${invocation.stderr.trim()}` : ""
          ]
            .filter(Boolean)
            .join("\n\n")
        );
      }

      const output = JSON.parse(markerLine.slice("__SKELETON_RESULT__".length));
      const cleanedStdout = invocation.stdout
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("__SKELETON_RESULT__"))
        .join("\n")
        .trim();

      return {
        output,
        stdout: cleanedStdout,
        stderr: invocation.stderr.trim()
      };
    } finally {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async runPythonScript(scriptPath: string): Promise<{ stdout: string; stderr: string }> {
    const attempts: Array<{ command: string; args: string[] }> = [
      { command: process.env.PYTHON_EXECUTABLE || "", args: [scriptPath] },
      { command: "py", args: ["-3", scriptPath] },
      { command: "python", args: [scriptPath] },
      { command: "python3", args: [scriptPath] }
    ].filter((attempt) => attempt.command);

    const errors: string[] = [];

    for (const attempt of attempts) {
      try {
        return await spawnForResult(attempt.command, attempt.args);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    throw new Error(
      `Unable to execute published Python package. ${errors.join(" | ") || "No Python runtime attempts were made."}`
    );
  }

  private async resolvePublishedRelease(packageId: string): Promise<CapabilityReleaseRecord> {
    const liveRecord = await this.storage.getRecord<CapabilityLiveRecord>(
      CAPABILITY_OWNER_ID,
      CAPABILITY_LIVE_COLLECTION,
      `live:${packageId}`
    );
    if (!liveRecord?.releaseId) {
      throw new Error(`No published live record exists for capability package ${packageId}.`);
    }
    return this.resolveReleaseById(liveRecord.releaseId);
  }

  private async resolveReleaseById(releaseId: string): Promise<CapabilityReleaseRecord> {
    const release = await this.storage.getRecord<CapabilityReleaseRecord>(
      CAPABILITY_OWNER_ID,
      CAPABILITY_RELEASE_COLLECTION,
      releaseId
    );
    if (!release) {
      throw new Error(`Capability release ${releaseId} was not found.`);
    }
    return release;
  }

  private async persistRun(run: BoundedExecutorRunRecord): Promise<void> {
    await this.storage.putRecord(OWNER_ID, RUN_COLLECTION, run.runId, run);
    await this.storage.appendEvent(OWNER_ID, EVENT_STREAM, {
      eventId: randomUUID(),
      ownerId: OWNER_ID,
      stream: EVENT_STREAM,
      type: `executor-${run.status}`,
      summary: `${run.actionKind} ${run.actionId} is ${run.status}.`,
      details: {
        runId: run.runId,
        requestedByOwnerId: run.requestedByOwnerId,
        actionKind: run.actionKind,
        actionId: run.actionId,
        permissionDenials: run.permissionDenials,
        outputCount: run.outputs.length,
        failureCount: run.failures.length
      },
      createdAt: new Date().toISOString()
    });
  }
}

function makeOutput(outputId: string, label: string, body: Record<string, unknown>): BoundedExecutorOutputRecord {
  return {
    outputId,
    label,
    mediaType: "application/json",
    body: JSON.stringify(body, null, 2),
    createdAt: new Date().toISOString()
  };
}

function objectFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayFrom(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringFrom(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function escapeForTripleSingleQuotedString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'''/g, "\\'\\'\\'");
}

function spawnForResult(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          [
            `Python process exited with code ${code ?? "unknown"} for command: ${command} ${args.join(" ")}`.trim(),
            stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
            stdout.trim() ? `stdout:\n${stdout.trim()}` : ""
          ]
            .filter(Boolean)
            .join("\n\n")
        )
      );
    });
  });
}
