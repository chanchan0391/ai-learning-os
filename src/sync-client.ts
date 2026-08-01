import { parseLearningState } from "./learning-state";
import type { DailyLearningRecord, LearningPlan, LearningState } from "./types";

export const SYNC_METADATA_KEY = "ai-learning-os-sync-v1";

interface SyncEntity<T = unknown> {
  entityType: "learning-plan" | "daily-record";
  entityId: string;
  revision: number;
  updatedAt: string;
  value: T;
}

interface SyncMetadataEntry {
  revision: number;
  fingerprint: string;
}

interface SyncMetadata {
  version: 1;
  planId: string;
  entities: Record<string, SyncMetadataEntry>;
}

export type AuthState =
  | { status: "checking" }
  | { status: "local-only" }
  | { status: "signed-out" }
  | { status: "signed-in"; userId: string; deviceId: string };

export interface SyncResult {
  state: LearningState | null;
  uploaded: number;
  downloaded: number;
}

export class SyncConflictError extends Error {
  constructor(message = "本地与云端进度都已更改，请先导出备份后再选择要保留的版本。") {
    super(message);
    this.name = "SyncConflictError";
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function fingerprint(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function metadataKey(entity: Pick<SyncEntity, "entityType" | "entityId">): string {
  return `${entity.entityType}:${entity.entityId}`;
}

function recordId(planId: string, record: DailyLearningRecord): string {
  return `${planId}:day-${record.day}`;
}

function operationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function responseError(body: unknown, fallback: string): string {
  return body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : fallback;
}

export class BrowserSyncClient {
  constructor(
    private readonly storage: Storage,
    private readonly request: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async getAuthState(): Promise<AuthState> {
    try {
      const response = await this.request("/api/auth/session", { credentials: "same-origin" });
      if (response.status === 401) return { status: "signed-out" };
      if (response.status === 503) return { status: "local-only" };
      if (!response.ok) return { status: "local-only" };
      const body = await response.json() as { authenticated?: boolean; principal?: { userId?: string; deviceId?: string } };
      return body.authenticated && body.principal?.userId && body.principal.deviceId
        ? { status: "signed-in", userId: body.principal.userId, deviceId: body.principal.deviceId }
        : { status: "signed-out" };
    } catch {
      return { status: "local-only" };
    }
  }

  async logout(): Promise<void> {
    const response = await this.request("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    if (!response.ok) throw new Error("退出登录失败");
  }

  clearMetadata(): void {
    this.storage.removeItem(SYNC_METADATA_KEY);
  }

  async sync(localState: LearningState | null): Promise<SyncResult> {
    const response = await this.request("/api/sync/changes", { credentials: "same-origin" });
    const body = await response.json() as { changes?: SyncEntity[]; error?: string };
    if (!response.ok || !Array.isArray(body.changes)) throw new Error(responseError(body, "无法读取云端进度"));

    const remoteEntities = body.changes;
    if (!localState) return this.restoreFromRemote(remoteEntities);

    const otherRemotePlan = remoteEntities.find((entity) => entity.entityType === "learning-plan" && entity.entityId !== localState.plan.id);
    const matchingRemotePlan = remoteEntities.find((entity) => entity.entityType === "learning-plan" && entity.entityId === localState.plan.id);
    if (!matchingRemotePlan && otherRemotePlan) {
      throw new SyncConflictError("云端已有另一份学习计划。请先导出本地备份，再决定要保留哪一份计划。");
    }

    const previous = this.loadMetadata(localState.plan.id);
    const nextMetadata: SyncMetadata = { version: 1, planId: localState.plan.id, entities: { ...previous.entities } };
    let nextState = structuredClone(localState);
    let uploaded = 0;
    let downloaded = 0;

    const planResult = await this.reconcile(
      { entityType: "learning-plan", entityId: localState.plan.id, value: nextState.plan },
      matchingRemotePlan,
      previous.entities[metadataKey({ entityType: "learning-plan", entityId: localState.plan.id })],
    );
    nextMetadata.entities[metadataKey(planResult.entity)] = planResult.metadata;
    if (planResult.direction === "upload") uploaded += 1;
    if (planResult.direction === "download") {
      nextState.plan = planResult.entity.value as LearningPlan;
      downloaded += 1;
    }

    for (let index = 0; index < nextState.days.length; index += 1) {
      const record = nextState.days[index];
      const entityId = recordId(nextState.plan.id, record);
      const remote = remoteEntities.find((entity) => entity.entityType === "daily-record" && entity.entityId === entityId);
      const key = metadataKey({ entityType: "daily-record", entityId });
      const result = await this.reconcile(
        { entityType: "daily-record", entityId, value: { planId: nextState.plan.id, record } },
        remote,
        previous.entities[key],
      );
      nextMetadata.entities[key] = result.metadata;
      if (result.direction === "upload") uploaded += 1;
      if (result.direction === "download") {
        nextState.days[index] = (result.entity.value as { record: DailyLearningRecord }).record;
        downloaded += 1;
      }
    }

    const knownDays = new Set(nextState.days.map((day) => day.day));
    const newRemoteRecords = remoteEntities
      .filter((entity) => entity.entityType === "daily-record")
      .filter((entity) => (entity.value as { planId?: string }).planId === nextState.plan.id)
      .filter((entity) => !knownDays.has((entity.value as { record: DailyLearningRecord }).record.day));
    for (const entity of newRemoteRecords) {
      nextState.days.push((entity.value as { record: DailyLearningRecord }).record);
      nextMetadata.entities[metadataKey(entity)] = { revision: entity.revision, fingerprint: fingerprint(entity.value) };
      downloaded += 1;
    }
    nextState.days.sort((left, right) => left.day - right.day);
    nextState.currentDay = nextState.days.find((day) => day.status === "active")?.day ?? nextState.days.at(-1)?.day ?? 1;
    nextState = this.validateState(nextState);
    this.storage.setItem(SYNC_METADATA_KEY, JSON.stringify(nextMetadata));
    return { state: nextState, uploaded, downloaded };
  }

  private async reconcile(
    local: { entityType: SyncEntity["entityType"]; entityId: string; value: unknown },
    remote: SyncEntity | undefined,
    previous: SyncMetadataEntry | undefined,
  ): Promise<{ entity: SyncEntity; metadata: SyncMetadataEntry; direction: "none" | "upload" | "download" }> {
    const localFingerprint = fingerprint(local.value);
    if (!remote) {
      const entity = await this.write(local, null);
      return { entity, metadata: { revision: entity.revision, fingerprint: localFingerprint }, direction: "upload" };
    }
    const remoteFingerprint = fingerprint(remote.value);
    if (localFingerprint === remoteFingerprint) {
      return { entity: remote, metadata: { revision: remote.revision, fingerprint: remoteFingerprint }, direction: "none" };
    }
    if (previous?.revision === remote.revision && previous.fingerprint !== localFingerprint) {
      const entity = await this.write(local, remote.revision);
      return { entity, metadata: { revision: entity.revision, fingerprint: localFingerprint }, direction: "upload" };
    }
    if (previous?.fingerprint === localFingerprint && previous.revision !== remote.revision) {
      return { entity: remote, metadata: { revision: remote.revision, fingerprint: remoteFingerprint }, direction: "download" };
    }
    throw new SyncConflictError();
  }

  private async write(local: { entityType: SyncEntity["entityType"]; entityId: string; value: unknown }, revision: number | null): Promise<SyncEntity> {
    const collection = local.entityType === "learning-plan" ? "plans" : "daily-records";
    const response = await this.request(`/api/sync/${collection}/${encodeURIComponent(local.entityId)}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": operationId(),
        ...(revision === null ? { "If-None-Match": "*" } : { "If-Match": `"${revision}"` }),
      },
      body: JSON.stringify(local.value),
    });
    const body = await response.json();
    if (response.status === 409) throw new SyncConflictError();
    if (!response.ok) throw new Error(responseError(body, "云端写入失败"));
    return body as SyncEntity;
  }

  private restoreFromRemote(entities: SyncEntity[]): SyncResult {
    const planEntity = entities
      .filter((entity) => entity.entityType === "learning-plan")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!planEntity) return { state: null, uploaded: 0, downloaded: 0 };
    const plan = planEntity.value as LearningPlan;
    const recordEntities = entities
      .filter((entity) => entity.entityType === "daily-record")
      .filter((entity) => (entity.value as { planId?: string }).planId === plan.id);
    const days = recordEntities.map((entity) => (entity.value as { record: DailyLearningRecord }).record).sort((left, right) => left.day - right.day);
    if (days.length === 0) throw new Error("云端计划缺少每日学习记录");
    const state = this.validateState({
      version: 3,
      plan,
      currentDay: days.find((day) => day.status === "active")?.day ?? days.at(-1)!.day,
      days,
    });
    const metadata: SyncMetadata = { version: 1, planId: plan.id, entities: {} };
    for (const entity of [planEntity, ...recordEntities]) {
      metadata.entities[metadataKey(entity)] = { revision: entity.revision, fingerprint: fingerprint(entity.value) };
    }
    this.storage.setItem(SYNC_METADATA_KEY, JSON.stringify(metadata));
    return { state, uploaded: 0, downloaded: 1 + recordEntities.length };
  }

  private loadMetadata(planId: string): SyncMetadata {
    try {
      const parsed = JSON.parse(this.storage.getItem(SYNC_METADATA_KEY) ?? "null") as Partial<SyncMetadata> | null;
      if (parsed?.version === 1 && parsed.planId === planId && parsed.entities && typeof parsed.entities === "object") {
        return parsed as SyncMetadata;
      }
    } catch {
      // Corrupt sync metadata can be discarded without touching learning data.
    }
    return { version: 1, planId, entities: {} };
  }

  private validateState(state: LearningState): LearningState {
    const parsed = parseLearningState(JSON.stringify(state));
    if (!parsed.state) throw new Error("云端学习记录未通过完整校验");
    return parsed.state;
  }
}
