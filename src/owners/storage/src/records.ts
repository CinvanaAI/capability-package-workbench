export interface StorageEventRecord {
  eventId: string;
  ownerId: string;
  stream: string;
  type: string;
  summary: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface StorageArtifactRecord {
  artifactId: string;
  ownerId: string;
  mediaType: string;
  byteLength: number;
  path: string;
  metadata: Record<string, string>;
  createdAt: string;
}

export interface StorageMigrationRecord {
  migrationId: string;
  ownerId: string;
  label: string;
  status: "applied" | "failed";
  summary: string;
  appliedAt: string;
  details?: Record<string, unknown>;
}

export interface StorageCollectionSummary {
  collectionId: string;
  path: string;
  recordCount: number;
}

export interface StorageEventStreamSummary {
  streamId: string;
  path: string;
  eventCount: number;
}

export interface StorageNamespaceSummary {
  ownerId: string;
  rootPath: string;
  collectionCount: number;
  recordCount: number;
  eventCount: number;
  collections: StorageCollectionSummary[];
  eventStreams: StorageEventStreamSummary[];
  artifactCount: number;
  migrationCount: number;
}

export interface StorageObservability {
  rootPath: string;
  namespaceCount: number;
  recordCount: number;
  eventCount: number;
  artifactCount: number;
  migrationCount: number;
  namespaces: StorageNamespaceSummary[];
}
