import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  StorageArtifactRecord,
  StorageEventRecord,
  StorageMigrationRecord,
  StorageObservability,
  StorageNamespaceSummary
} from "./records.js";

const ARTIFACT_INDEX_COLLECTION = "_artifact-index";
const MIGRATION_COLLECTION = "_migrations";

export class StorageSubstrateService {
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(private readonly dataRoot: string) {}

  get rootPath(): string {
    return path.join(this.dataRoot, "owners");
  }

  async putRecord<T>(ownerId: string, collection: string, key: string, record: T): Promise<void> {
    const destination = this.recordPath(ownerId, collection, key);
    const payload = `${JSON.stringify(record, null, 2)}\n`;
    await this.enqueueWrite(`file:${destination}`, async () => {
      await mkdir(this.collectionPath(ownerId, collection), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, payload, { encoding: "utf8", flag: "wx" });
        // Windows may briefly deny replacement while another reader holds a handle.
        // Retry replacement; never delete the valid destination to make room.
        for (let attempt = 0; ; attempt += 1) {
          try {
            await rename(temporary, destination);
            break;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    });
  }

  async updateRecord<T>(
    ownerId: string,
    collection: string,
    key: string,
    update: (current: T | undefined) => T | Promise<T>
  ): Promise<T> {
    return this.enqueueWrite(`${ownerId}:${collection}:${key}`, async () => {
      const current = await this.getRecord<T>(ownerId, collection, key);
      const next = await update(current);
      await this.putRecord(ownerId, collection, key, next);
      return next;
    });
  }

  async deleteRecord(ownerId: string, collection: string, key: string): Promise<boolean> {
    return this.enqueueWrite(`${ownerId}:${collection}:${key}`, async () => {
      try {
        await rm(this.recordPath(ownerId, collection, key), { force: true });
        return true;
      } catch {
        return false;
      }
    });
  }

  async getRecord<T>(
    ownerId: string,
    collection: string,
    key: string
  ): Promise<T | undefined> {
    try {
      const raw = await readFile(this.recordPath(ownerId, collection, key), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async listRecords<T>(ownerId: string, collection: string): Promise<T[]> {
    try {
      const names = (await readdir(this.collectionPath(ownerId, collection))).sort(
        (left: string, right: string) => left.localeCompare(right)
      );
      return Promise.all(
        names
          .filter((name: string) => name.endsWith(".json"))
          .map(async (name: string) => {
            const raw = await readFile(path.join(this.collectionPath(ownerId, collection), name), "utf8");
            return JSON.parse(raw) as T;
          })
      );
    } catch {
      return [];
    }
  }

  async appendEvent(ownerId: string, stream: string, event: StorageEventRecord): Promise<void> {
    const eventsRoot = this.eventsRoot(ownerId);
    await mkdir(eventsRoot, { recursive: true });
    await appendFile(path.join(eventsRoot, `${encodeKey(stream)}.jsonl`), `${JSON.stringify(event)}\n`, "utf8");
  }

  async listEvents(ownerId: string, stream: string, limit = 50): Promise<StorageEventRecord[]> {
    try {
      const raw = await readFile(path.join(this.eventsRoot(ownerId), `${encodeKey(stream)}.jsonl`), "utf8");
      return raw
        .split(/\r?\n/)
        .map((line: string) => line.trim())
        .filter(Boolean)
        .map((line: string) => JSON.parse(line) as StorageEventRecord)
        .slice(-limit)
        .reverse();
    } catch {
      return [];
    }
  }

  async putArtifact(input: {
    ownerId: string;
    artifactId: string;
    mediaType: string;
    body: string;
    metadata?: Record<string, string>;
  }): Promise<StorageArtifactRecord> {
    const artifactsRoot = this.artifactsRoot(input.ownerId);
    await mkdir(artifactsRoot, { recursive: true });
    const artifactPath = path.join(artifactsRoot, `${encodeKey(input.artifactId)}.artifact`);
    await writeFile(artifactPath, input.body, "utf8");
    const record: StorageArtifactRecord = {
      artifactId: input.artifactId,
      ownerId: input.ownerId,
      mediaType: input.mediaType,
      byteLength: Buffer.byteLength(input.body, "utf8"),
      path: artifactPath,
      metadata: normalizeMetadata(input.metadata),
      createdAt: new Date().toISOString()
    };
    await this.putRecord(input.ownerId, ARTIFACT_INDEX_COLLECTION, input.artifactId, record);
    return record;
  }

  async getArtifactText(ownerId: string, artifactId: string): Promise<string | undefined> {
    const record = await this.getRecord<StorageArtifactRecord>(
      ownerId,
      ARTIFACT_INDEX_COLLECTION,
      artifactId
    );
    if (!record) {
      return undefined;
    }
    try {
      return await readFile(record.path, "utf8");
    } catch {
      return undefined;
    }
  }

  async listArtifacts(ownerId: string, prefix?: string): Promise<StorageArtifactRecord[]> {
    const artifacts = await this.listRecords<StorageArtifactRecord>(
      ownerId,
      ARTIFACT_INDEX_COLLECTION
    );
    return artifacts
      .filter((artifact) => (prefix ? artifact.artifactId.startsWith(prefix) : true))
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  }

  async recordMigration(input: {
    ownerId: string;
    migrationId: string;
    label: string;
    status: StorageMigrationRecord["status"];
    summary: string;
    details?: Record<string, unknown>;
  }): Promise<StorageMigrationRecord> {
    const record: StorageMigrationRecord = {
      migrationId: input.migrationId,
      ownerId: input.ownerId,
      label: input.label,
      status: input.status,
      summary: input.summary,
      appliedAt: new Date().toISOString(),
      ...(input.details ? { details: input.details } : {})
    };
    await this.putRecord(input.ownerId, MIGRATION_COLLECTION, input.migrationId, record);
    return record;
  }

  async listMigrations(ownerId: string): Promise<StorageMigrationRecord[]> {
    const migrations = await this.listRecords<StorageMigrationRecord>(ownerId, MIGRATION_COLLECTION);
    return migrations.sort((left, right) => right.appliedAt.localeCompare(left.appliedAt));
  }

  namespacePath(ownerId: string, collection?: string): string {
    return collection ? this.collectionPath(ownerId, collection) : path.join(this.rootPath, encodeKey(ownerId));
  }

  async inspectObservability(): Promise<StorageObservability> {
    const namespaces = await this.inspectNamespaces();
    return {
      rootPath: this.rootPath,
      namespaceCount: namespaces.length,
      recordCount: namespaces.reduce((sum, namespace) => sum + namespace.recordCount, 0),
      eventCount: namespaces.reduce((sum, namespace) => sum + namespace.eventCount, 0),
      artifactCount: namespaces.reduce((sum, namespace) => sum + namespace.artifactCount, 0),
      migrationCount: namespaces.reduce((sum, namespace) => sum + namespace.migrationCount, 0),
      namespaces
    };
  }

  private async inspectNamespaces(): Promise<StorageNamespaceSummary[]> {
    try {
      await mkdir(this.rootPath, { recursive: true });
      const entries = await readdir(this.rootPath, { withFileTypes: true });
      const namespaces = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const ownerId = decodeKey(entry.name);
            const ownerPath = path.join(this.rootPath, entry.name);
            const ownerEntries = await readdir(ownerPath, { withFileTypes: true });
            const collections = [];
            const eventStreams = [];
            let rawArtifactFileCount = 0;

            for (const ownerEntry of ownerEntries) {
              if (!ownerEntry.isDirectory()) {
                continue;
              }
              const entryPath = path.join(ownerPath, ownerEntry.name);
              if (ownerEntry.name === "_events") {
                const streamFiles = await readdir(entryPath, { withFileTypes: true });
                for (const streamFile of streamFiles) {
                  if (!streamFile.isFile() || !streamFile.name.endsWith(".jsonl")) {
                    continue;
                  }
                  const streamPath = path.join(entryPath, streamFile.name);
                  const raw = await readFile(streamPath, "utf8").catch(() => "");
                  eventStreams.push({
                    streamId: decodeFileKey(streamFile.name),
                    path: streamPath,
                    eventCount: raw
                      .split(/\r?\n/)
                      .map((line) => line.trim())
                      .filter(Boolean).length
                  });
                }
                continue;
              }
              if (ownerEntry.name === "_artifacts") {
                rawArtifactFileCount = await countFiles(entryPath);
                continue;
              }

              const collectionFiles = await readdir(entryPath, { withFileTypes: true });
              collections.push({
                collectionId: decodeKey(ownerEntry.name),
                path: entryPath,
                recordCount: collectionFiles.filter(
                  (file) => file.isFile() && file.name.endsWith(".json")
                ).length
              });
            }

            const recordCount = collections.reduce((sum, collection) => sum + collection.recordCount, 0);
            const eventCount = eventStreams.reduce((sum, stream) => sum + stream.eventCount, 0);
            const artifactCount =
              collections.find((collection) => collection.collectionId === ARTIFACT_INDEX_COLLECTION)
                ?.recordCount ?? rawArtifactFileCount;
            const migrationCount =
              collections.find((collection) => collection.collectionId === MIGRATION_COLLECTION)
                ?.recordCount ?? 0;

            return {
              ownerId,
              rootPath: ownerPath,
              collectionCount: collections.length,
              recordCount,
              eventCount,
              artifactCount,
              migrationCount,
              collections: collections.sort((left, right) =>
                left.collectionId.localeCompare(right.collectionId)
              ),
              eventStreams: eventStreams.sort((left, right) =>
                left.streamId.localeCompare(right.streamId)
              )
            } satisfies StorageNamespaceSummary;
          })
      );

      return namespaces.sort((left, right) => left.ownerId.localeCompare(right.ownerId));
    } catch {
      return [];
    }
  }

  private collectionPath(ownerId: string, collection: string): string {
    return path.join(this.rootPath, encodeKey(ownerId), encodeKey(collection));
  }

  private recordPath(ownerId: string, collection: string, key: string): string {
    return path.join(this.collectionPath(ownerId, collection), `${encodeKey(key)}.json`);
  }

  private eventsRoot(ownerId: string): string {
    return path.join(this.rootPath, encodeKey(ownerId), "_events");
  }

  private artifactsRoot(ownerId: string): string {
    return path.join(this.rootPath, encodeKey(ownerId), "_artifacts");
  }

  private enqueueWrite<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    const queued = next.finally(() => {
      if (this.writes.get(key) === queued) {
        this.writes.delete(key);
      }
    });
    this.writes.set(key, queued);
    return queued;
  }
}

function encodeKey(value: string): string {
  return encodeURIComponent(value.trim() || "record").replace(/%/g, "_");
}

function decodeKey(value: string): string {
  try {
    return decodeURIComponent(value.replace(/_/g, "%"));
  } catch {
    return value;
  }
}

function decodeFileKey(value: string): string {
  return decodeKey(value.replace(/\.jsonl$/i, "").replace(/\.json$/i, ""));
}

function normalizeMetadata(input?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input ?? {}).map(([key, value]) => [key, String(value)])
  );
}

async function countFiles(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countFiles(path.join(root, entry.name));
      continue;
    }
    if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}
