export type HostContainerKind = "mixed" | "workbench-heavy" | "admin-heavy";
export type HostSurfaceCategory = "workbench" | "observability" | "admin";
export type HostEnvironmentStatus = "pending" | "ready" | "degraded";

export interface HostSurfaceDescriptor {
  surfaceId: string;
  label: string;
  category: HostSurfaceCategory;
  summary: string;
}

export interface HostContainerDescriptor {
  containerId: string;
  ownerId: string;
  label: string;
  summary: string;
  kind: HostContainerKind;
  defaultSurfaceId: string;
  surfaces: HostSurfaceDescriptor[];
  environmentId?: string;
}

export interface HostEnvironmentProjection {
  environmentId: string;
  ownerId: string;
  label: string;
  status: HostEnvironmentStatus;
  ready: boolean;
  summary: string;
}

export interface HostPlatformInfo {
  title: string;
  runtimeVersion: string;
  workspaceRoot: string;
  dataRoot: string;
  startedAt: string;
}

export interface NativeBridgeProjection {
  desktop: boolean;
  openPath: boolean;
}

export interface HostBootstrapPayload {
  platform: HostPlatformInfo;
  containers: HostContainerDescriptor[];
  environments: HostEnvironmentProjection[];
  nativeBridge: NativeBridgeProjection;
}

export interface FrameworkDiagnostics {
  platform: HostPlatformInfo;
  containers: HostContainerDescriptor[];
  environments: HostEnvironmentProjection[];
  coordination: {
    eventCount: number;
    recentEvents: Array<{
      eventId: string;
      ownerId: string;
      type: string;
      summary: string;
      createdAt: string;
    }>;
  };
}
