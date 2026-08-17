import { parseLearningState } from "./learning-state";
import type { ArchivedLearningState } from "./learning-storage";
import type { DailyLearningRecord, LearningPlan, LearningState } from "./types";
import { readBoundedJson } from "./bounded-json-response";

export const SYNC_METADATA_KEY = "ai-learning-os-sync-v1";
const RESTORED_ARCHIVE_PLAN_KEY = "ai-learning-os-restored-archive-v1";
const MAX_SYNC_PAGE_ENTITIES = 250;
const MAX_SYNC_RESPONSE_BYTES = 9 * 1024 * 1024;
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_SYNC_ENTITIES = 25_000;
const MAX_SYNC_PAGES = MAX_SYNC_ENTITIES / MAX_SYNC_PAGE_ENTITIES;
const MAX_SYNC_IDENTIFIER_CHARACTERS = 256;
const MAX_SYNC_TIMESTAMP_CHARACTERS = 64;
const MAX_ACTIVE_DEVICES = 1_000;
const MAX_DEVICE_LABEL_CHARACTERS = 100;
const ACCOUNT_REQUEST_TIMEOUT_MS = 15_000;

interface BrowserSyncClientOptions {
  accountRequestTimeoutMs?: number;
}

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

interface LegacySyncMetadata {
  version: 1;
  planId: string;
  entities: Record<string, SyncMetadataEntry>;
}

interface SyncMetadata {
  version: 2;
  plans: Record<string, Record<string, SyncMetadataEntry>>;
}

interface PlanSyncMetadata {
  planId: string;
  entities: Record<string, SyncMetadataEntry>;
}

export type AuthState =
  | { status: "checking" }
  | { status: "local-only" }
  | { status: "signed-out" }
  | { status: "signed-in"; userId: string; deviceId: string };

export interface ActiveDevice {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

type AuthSessionEnvelope =
  | { authenticated: false }
  | { authenticated: true; principal: { userId: string; deviceId: string } };

export interface SyncResult {
  state: LearningState | null;
  uploaded: number;
  downloaded: number;
}

export interface ActiveSyncResult {
  states: LearningState[];
  uploaded: number;
  downloaded: number;
}

export interface ArchivedSyncResult {
  entries: ArchivedLearningState[];
  downloaded: number;
}

export interface SyncConflictPreview {
  kind: "different-plan" | "diverged-entity";
  entityType?: SyncEntity["entityType"];
  entityId?: string;
  remoteRevision?: number;
  remoteUpdatedAt?: string;
  localState: LearningState;
  remoteState: LearningState;
  localValue?: unknown;
  remoteValue?: unknown;
}

export class SyncConflictError extends Error {
  constructor(
    message = "本地与云端进度都已更改，请比较后选择要保留的冲突版本。",
    readonly preview?: SyncConflictPreview,
  ) {
    super(message);
    this.name = "SyncConflictError";
  }
}

export class AuthSessionExpiredError extends Error {
  constructor(message = "登录已过期，请重新登录后继续同步。") {
    super(message);
    this.name = "AuthSessionExpiredError";
  }
}

export class PermanentSyncError extends Error {
  constructor(message = "同步请求无法完成，请手动重试；如持续失败，请导出备份并联系支持。") {
    super(message);
    this.name = "PermanentSyncError";
  }
}

function throwForSyncResponse(response: Response, body: unknown, fallback: string): void {
  if (response.status === 401) throw new AuthSessionExpiredError();
  if (response.ok) return;
  if (response.status === 409 && responseError(body, "") === "revision-conflict") {
    throw new SyncConflictError();
  }
  if (response.status === 507) {
    throw new PermanentSyncError("云端同步空间已满，请先导出备份并联系支持。");
  }
  if (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status)) {
    throw new PermanentSyncError();
  }
  throw new Error(fallback);
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

function isSyncEntity(value: unknown): value is SyncEntity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entity = value as Partial<SyncEntity>;
  return (entity.entityType === "learning-plan" || entity.entityType === "daily-record")
    && typeof entity.entityId === "string"
    && entity.entityId.trim().length > 0
    && entity.entityId.length <= MAX_SYNC_IDENTIFIER_CHARACTERS
    && Number.isSafeInteger(entity.revision)
    && entity.revision! >= 1
    && typeof entity.updatedAt === "string"
    && entity.updatedAt.length > 0
    && entity.updatedAt.length <= MAX_SYNC_TIMESTAMP_CHARACTERS
    && Number.isFinite(Date.parse(entity.updatedAt))
    && Object.prototype.hasOwnProperty.call(entity, "value");
}

function isBoundedSyncCursor(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= MAX_SYNC_IDENTIFIER_CHARACTERS;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= MAX_SYNC_IDENTIFIER_CHARACTERS;
}

function isValidAuthState(value: unknown): value is AuthSessionEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.authenticated === false) return hasExactKeys(envelope, ["authenticated"]);
  if (envelope.authenticated !== true || !hasExactKeys(envelope, ["authenticated", "principal"])) return false;
  if (!envelope.principal || typeof envelope.principal !== "object" || Array.isArray(envelope.principal)) return false;
  const principal = envelope.principal as Record<string, unknown>;
  return hasExactKeys(principal, ["deviceId", "userId"])
    && isBoundedIdentifier(principal.userId)
    && isBoundedIdentifier(principal.deviceId);
}

function isActiveDevice(value: unknown): value is ActiveDevice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const device = value as Record<string, unknown>;
  return hasExactKeys(device, ["createdAt", "current", "id", "label", "lastSeenAt"])
    && isBoundedIdentifier(device.id)
    && typeof device.label === "string"
    && device.label.trim().length > 0
    && device.label.length <= MAX_DEVICE_LABEL_CHARACTERS
    && typeof device.createdAt === "string"
    && device.createdAt.length > 0
    && device.createdAt.length <= MAX_SYNC_TIMESTAMP_CHARACTERS
    && Number.isFinite(Date.parse(device.createdAt))
    && typeof device.lastSeenAt === "string"
    && device.lastSeenAt.length > 0
    && device.lastSeenAt.length <= MAX_SYNC_TIMESTAMP_CHARACTERS
    && Number.isFinite(Date.parse(device.lastSeenAt))
    && typeof device.current === "boolean";
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

async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function throwForAccountResponse(response: Response, fallback: string, discardBody = false): Promise<void> {
  if (!response.ok || discardBody) await discardResponseBody(response);
  if (response.status === 401) throw new AuthSessionExpiredError();
  if (!response.ok) throw new Error(fallback);
}

export class BrowserSyncClient {
  private readonly accountRequestTimeoutMs: number;

  constructor(
    private readonly storage: Storage,
    private readonly request: typeof fetch = (input, init) => fetch(input, init),
    options: BrowserSyncClientOptions = {},
  ) {
    this.accountRequestTimeoutMs = options.accountRequestTimeoutMs ?? ACCOUNT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.accountRequestTimeoutMs) || this.accountRequestTimeoutMs <= 0) {
      throw new TypeError("Account request timeout must be a positive finite number");
    }
  }

  private async accountRequest<T>(
    input: RequestInfo | URL,
    init: RequestInit,
    timeoutMessage: string,
    consume: (response: Response) => T | Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.accountRequestTimeoutMs);
    try {
      const response = await this.request(input, { ...init, signal: controller.signal });
      return await consume(response);
    } catch (error) {
      if (controller.signal.aborted) throw new Error(timeoutMessage);
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  async getAuthState(): Promise<AuthState> {
    try {
      return await this.accountRequest(
        "/api/auth/session",
        { credentials: "same-origin" },
        "账号状态读取超时，请稍后重试",
        async (response) => {
          if (!response.ok) {
            await discardResponseBody(response);
            return response.status === 401 ? { status: "signed-out" } : { status: "local-only" };
          }
          const body = await readBoundedJson<{ authenticated?: boolean; principal?: { userId?: string; deviceId?: string } }>(
            response, MAX_AUTH_RESPONSE_BYTES, "账号响应超过安全上限，请稍后重试",
          );
          if (!isValidAuthState(body)) return { status: "local-only" };
          return body.authenticated
            ? { status: "signed-in", userId: body.principal.userId, deviceId: body.principal.deviceId }
            : { status: "signed-out" };
        },
      );
    } catch {
      return { status: "local-only" };
    }
  }

  async logout(): Promise<void> {
    const fallback = "退出登录失败，请稍后重试";
    await this.accountRequest(
      "/api/auth/logout",
      { method: "POST", credentials: "same-origin" },
      fallback,
      (response) => throwForAccountResponse(response, fallback, true),
    );
  }

  async logoutAll(): Promise<void> {
    const fallback = "退出所有设备失败，请稍后重试";
    await this.accountRequest(
      "/api/auth/logout-all",
      { method: "POST", credentials: "same-origin" },
      fallback,
      (response) => throwForAccountResponse(response, fallback, true),
    );
  }

  async getActiveDevices(): Promise<ActiveDevice[]> {
    const fallback = "无法读取登录设备，请稍后重试";
    return this.accountRequest(
      "/api/auth/devices",
      { credentials: "same-origin" },
      fallback,
      async (response) => {
        await throwForAccountResponse(response, fallback);
        const body = await readBoundedJson<{ devices?: ActiveDevice[]; error?: string }>(
          response, MAX_AUTH_RESPONSE_BYTES, "账号响应超过安全上限，请稍后重试",
        );
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("登录设备响应格式无效，请稍后重试");
        const envelope = body as Record<string, unknown>;
        if (!hasExactKeys(envelope, ["devices"]) || !Array.isArray(envelope.devices)
          || envelope.devices.length === 0 || envelope.devices.length > MAX_ACTIVE_DEVICES
          || !envelope.devices.every(isActiveDevice)) {
          throw new Error("登录设备响应格式无效，请稍后重试");
        }
        const devices = envelope.devices as ActiveDevice[];
        const uniqueIds = new Set(devices.map((device) => device.id));
        if (uniqueIds.size !== devices.length || devices.filter((device) => device.current).length !== 1) {
          throw new Error("登录设备响应格式无效，请稍后重试");
        }
        return devices;
      },
    );
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const fallback = "设备退出失败，请稍后重试";
    await this.accountRequest(
      `/api/auth/devices/${encodeURIComponent(deviceId)}`,
      { method: "DELETE", credentials: "same-origin" },
      fallback,
      (response) => throwForAccountResponse(response, fallback, true),
    );
  }

  async deleteAccount(): Promise<void> {
    const fallback = "账号数据删除失败，请稍后重试";
    await this.accountRequest(
      "/api/auth/account",
      { method: "DELETE", credentials: "same-origin" },
      fallback,
      (response) => throwForAccountResponse(response, fallback, true),
    );
  }

  clearMetadata(): void {
    this.storage.removeItem(SYNC_METADATA_KEY);
    this.storage.removeItem(RESTORED_ARCHIVE_PLAN_KEY);
  }

  markArchiveRestored(planId: string): void {
    this.storage.setItem(RESTORED_ARCHIVE_PLAN_KEY, planId);
  }

  async sync(localState: LearningState | null, signal?: AbortSignal): Promise<SyncResult> {
    const remoteEntities = await this.readAllChanges("无法读取云端进度", signal);
    if (!localState) {
      if (!remoteEntities.some((entity) => entity.entityType === "learning-plan" && !(entity.value as LearningPlan).archivedAt)) {
        return { state: null, uploaded: 0, downloaded: 0 };
      }
      return this.restoreFromRemote(remoteEntities);
    }

    const matchingRemotePlan = remoteEntities.find((entity) => entity.entityType === "learning-plan" && entity.entityId === localState.plan.id);

    const previous = this.loadMetadata(localState.plan.id);
    const restoringArchived = this.storage.getItem(RESTORED_ARCHIVE_PLAN_KEY) === localState.plan.id
      && Boolean((matchingRemotePlan?.value as LearningPlan | undefined)?.archivedAt)
      && !localState.plan.archivedAt;
    this.assertNoDivergedEntities(localState, remoteEntities, previous, restoringArchived);
    const nextMetadata: PlanSyncMetadata = { planId: localState.plan.id, entities: { ...previous.entities } };
    let nextState = structuredClone(localState);
    let uploaded = 0;
    let downloaded = 0;

    const localPlanEntity = { entityType: "learning-plan" as const, entityId: localState.plan.id, value: nextState.plan };
    const planResult = restoringArchived && matchingRemotePlan
      ? {
          entity: await this.write(localPlanEntity, matchingRemotePlan.revision, signal),
          metadata: { revision: matchingRemotePlan.revision + 1, fingerprint: fingerprint(localPlanEntity.value) },
          direction: "upload" as const,
        }
      : await this.reconcile(
          localPlanEntity,
          matchingRemotePlan,
          previous.entities[metadataKey(localPlanEntity)],
          signal,
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
        signal,
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
    signal?.throwIfAborted();
    this.saveMetadata(nextMetadata);
    if (this.storage.getItem(RESTORED_ARCHIVE_PLAN_KEY) === localState.plan.id) {
      this.storage.removeItem(RESTORED_ARCHIVE_PLAN_KEY);
    }
    return { state: nextState, uploaded, downloaded };
  }

  async syncActive(localStates: LearningState[], signal?: AbortSignal): Promise<ActiveSyncResult> {
    const states: LearningState[] = [];
    let uploaded = 0;
    let downloaded = 0;
    for (const localState of localStates) {
      const result = await this.sync(localState, signal);
      if (result.state) states.push(result.state);
      uploaded += result.uploaded;
      downloaded += result.downloaded;
    }

    const remoteEntities = await this.readAllChanges("无法读取云端进度", signal);
    const knownPlanIds = new Set(states.map((state) => state.plan.id));
    const missingPlans = remoteEntities
      .filter((entity) => entity.entityType === "learning-plan" && !(entity.value as LearningPlan).archivedAt)
      .filter((entity) => !knownPlanIds.has(entity.entityId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const planEntity of missingPlans) {
      const result = this.restoreFromRemote(remoteEntities, planEntity.entityId);
      if (result.state) states.push(result.state);
      downloaded += result.downloaded;
    }
    return { states, uploaded, downloaded };
  }

  /**
   * Reconciles a complete archived snapshot using the same per-entity revisions
   * as an active goal. The archive timestamp lives on the synchronized plan so
   * other devices can distinguish it from the one active plan.
   */
  async syncArchived(entry: ArchivedLearningState, signal?: AbortSignal): Promise<SyncResult> {
    return this.sync({
      ...structuredClone(entry.state),
      plan: { ...structuredClone(entry.state.plan), archivedAt: entry.archivedAt },
    }, signal);
  }

  async downloadArchived(existingPlanIds: Iterable<string>, activePlanId?: string, signal?: AbortSignal): Promise<ArchivedSyncResult> {
    const remoteEntities = await this.readAllChanges("无法读取云端归档", signal);

    const excluded = new Set(existingPlanIds);
    if (activePlanId) excluded.add(activePlanId);
    const entries: ArchivedLearningState[] = [];
    let downloaded = 0;
    for (const planEntity of remoteEntities
      .filter((entity) => entity.entityType === "learning-plan" && Boolean((entity.value as LearningPlan).archivedAt))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
      if (excluded.has(planEntity.entityId)) continue;
      const remoteState = this.stateFromRemote(remoteEntities, planEntity.entityId);
      const archivedAt = remoteState.plan.archivedAt;
      if (!archivedAt) continue;
      const { archivedAt: _archivedAt, ...activePlan } = remoteState.plan;
      const state = this.validateState({ ...remoteState, plan: activePlan });
      entries.push({ archivedAt, state });
      excluded.add(planEntity.entityId);
      downloaded += 1 + state.days.length;
    }
    return { entries, downloaded };
  }

  async resolveConflict(preview: SyncConflictPreview, choice: "local" | "remote", signal?: AbortSignal): Promise<SyncResult> {
    if (choice === "remote") {
      if (preview.kind === "different-plan") {
        const remoteEntities = await this.readAllChanges("无法读取云端进度", signal);
        return this.restoreFromRemote(remoteEntities, preview.remoteState.plan.id);
      }
      const nextState = this.applyRemoteEntity(preview.localState, preview);
      const previousMetadata = this.loadMetadata(nextState.plan.id);
      this.rememberResolvedEntity(nextState.plan.id, preview, "remote");
      try {
        return await this.sync(nextState, signal);
      } catch (error) {
        // The learning repository is only updated after the full resolution
        // succeeds. Roll back the temporary sync base as well so a later auto
        // sync cannot reinterpret the still-local version as a new edit.
        this.saveMetadata(previousMetadata);
        throw error;
      }
    }

    if (preview.kind === "different-plan") return this.uploadLocalPlan(preview.localState, signal);
    if (!preview.entityType || !preview.entityId || preview.remoteRevision === undefined) {
      throw new Error("冲突信息不完整，请重新同步。");
    }
    const entity = await this.write({
      entityType: preview.entityType,
      entityId: preview.entityId,
      value: preview.localValue,
    }, preview.remoteRevision, signal);
    this.rememberResolvedEntity(preview.localState.plan.id, { ...preview, remoteRevision: entity.revision }, "local");
    const result = await this.sync(preview.localState, signal);
    return { ...result, uploaded: result.uploaded + 1 };
  }

  private assertNoDivergedEntities(localState: LearningState, remoteEntities: SyncEntity[], previous: PlanSyncMetadata, restoringArchived = false): void {
    const locals = this.localEntities(localState);
    for (const local of locals) {
      if (restoringArchived && local.entityType === "learning-plan") continue;
      const remote = remoteEntities.find((entity) => entity.entityType === local.entityType && entity.entityId === local.entityId);
      if (!remote || fingerprint(local.value) === fingerprint(remote.value)) continue;
      const base = previous.entities[metadataKey(local)];
      const localChanged = base?.fingerprint !== fingerprint(local.value);
      const remoteChanged = base?.revision !== remote.revision;
      if (base && (!localChanged || !remoteChanged)) continue;
      throw new SyncConflictError(undefined, {
        kind: "diverged-entity",
        entityType: local.entityType,
        entityId: local.entityId,
        remoteRevision: remote.revision,
        remoteUpdatedAt: remote.updatedAt,
        localState,
        remoteState: this.stateFromRemote(remoteEntities, localState.plan.id),
        localValue: local.value,
        remoteValue: remote.value,
      });
    }
  }

  private localEntities(state: LearningState): Array<{ entityType: SyncEntity["entityType"]; entityId: string; value: unknown }> {
    return [
      { entityType: "learning-plan", entityId: state.plan.id, value: state.plan },
      ...state.days.map((record) => ({
        entityType: "daily-record" as const,
        entityId: recordId(state.plan.id, record),
        value: { planId: state.plan.id, record },
      })),
    ];
  }

  private applyRemoteEntity(localState: LearningState, preview: SyncConflictPreview): LearningState {
    const next = structuredClone(localState);
    if (preview.entityType === "learning-plan") next.plan = preview.remoteValue as LearningPlan;
    if (preview.entityType === "daily-record") {
      const record = (preview.remoteValue as { record: DailyLearningRecord }).record;
      const index = next.days.findIndex((day) => day.day === record.day);
      if (index >= 0) next.days[index] = record;
      else next.days.push(record);
    }
    return this.validateState(next);
  }

  private rememberResolvedEntity(planId: string, preview: SyncConflictPreview, source: "local" | "remote"): void {
    if (!preview.entityType || !preview.entityId || preview.remoteRevision === undefined) return;
    const metadata = this.loadMetadata(planId);
    const value = source === "local" ? preview.localValue : preview.remoteValue;
    metadata.entities[metadataKey({ entityType: preview.entityType, entityId: preview.entityId })] = {
      revision: preview.remoteRevision,
      fingerprint: fingerprint(value),
    };
    this.saveMetadata(metadata);
  }

  private async uploadLocalPlan(state: LearningState, signal?: AbortSignal): Promise<SyncResult> {
    const remoteEntities = await this.readAllChanges("无法读取云端进度", signal);
    const metadata: PlanSyncMetadata = { planId: state.plan.id, entities: {} };
    let uploaded = 0;
    for (const local of this.localEntities(state)) {
      const remote = remoteEntities.find((entity) => entity.entityType === local.entityType && entity.entityId === local.entityId);
      const entity = await this.write(local, remote?.revision ?? null, signal);
      metadata.entities[metadataKey(entity)] = { revision: entity.revision, fingerprint: fingerprint(entity.value) };
      uploaded += 1;
    }
    signal?.throwIfAborted();
    this.saveMetadata(metadata);
    return { state, uploaded, downloaded: 0 };
  }

  private async readAllChanges(fallbackError: string, signal?: AbortSignal): Promise<SyncEntity[]> {
    const entities = new Map<string, SyncEntity>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const response = await this.request(`/api/sync/changes${query}`, { credentials: "same-origin", signal });
      const body = await readBoundedJson<{ changes?: SyncEntity[]; cursor?: string; hasMore?: boolean; error?: string }>(
        response, MAX_SYNC_RESPONSE_BYTES, "云端同步响应超过安全上限，请稍后重试",
      );
      throwForSyncResponse(response, body, fallbackError);
      if (!Array.isArray(body.changes)) throw new Error("云端同步响应格式无效，请稍后重试");
      if (body.changes.length > MAX_SYNC_PAGE_ENTITIES) {
        throw new Error("云端同步分页超过安全上限，请稍后重试");
      }
      if ((body.hasMore !== undefined && typeof body.hasMore !== "boolean") || !body.changes.every(isSyncEntity)) {
        throw new Error("云端同步响应格式无效，请稍后重试");
      }
      for (const entity of body.changes) entities.set(metadataKey(entity), entity);
      if (entities.size >= MAX_SYNC_ENTITIES && body.hasMore === true) {
        throw new Error("云端学习记录过多，无法在单次同步中安全读取");
      }
      if (body.hasMore !== true) return [...entities.values()];
      if (!isBoundedSyncCursor(body.cursor) || seenCursors.has(body.cursor)) throw new Error("云端同步分页游标无效，请稍后重试");
      seenCursors.add(body.cursor);
      cursor = body.cursor;
    }
    throw new Error("云端学习记录过多，无法在单次同步中安全读取");
  }

  private async reconcile(
    local: { entityType: SyncEntity["entityType"]; entityId: string; value: unknown },
    remote: SyncEntity | undefined,
    previous: SyncMetadataEntry | undefined,
    signal?: AbortSignal,
  ): Promise<{ entity: SyncEntity; metadata: SyncMetadataEntry; direction: "none" | "upload" | "download" }> {
    const localFingerprint = fingerprint(local.value);
    if (!remote) {
      const entity = await this.write(local, null, signal);
      return { entity, metadata: { revision: entity.revision, fingerprint: localFingerprint }, direction: "upload" };
    }
    const remoteFingerprint = fingerprint(remote.value);
    if (localFingerprint === remoteFingerprint) {
      return { entity: remote, metadata: { revision: remote.revision, fingerprint: remoteFingerprint }, direction: "none" };
    }
    if (previous?.revision === remote.revision && previous.fingerprint !== localFingerprint) {
      const entity = await this.write(local, remote.revision, signal);
      return { entity, metadata: { revision: entity.revision, fingerprint: localFingerprint }, direction: "upload" };
    }
    if (previous?.fingerprint === localFingerprint && previous.revision !== remote.revision) {
      return { entity: remote, metadata: { revision: remote.revision, fingerprint: remoteFingerprint }, direction: "download" };
    }
    throw new SyncConflictError();
  }

  private async write(local: { entityType: SyncEntity["entityType"]; entityId: string; value: unknown }, revision: number | null, signal?: AbortSignal): Promise<SyncEntity> {
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
      signal,
    });
    const body = await readBoundedJson<unknown>(
      response, MAX_SYNC_RESPONSE_BYTES, "云端同步响应超过安全上限，请稍后重试",
    );
    throwForSyncResponse(response, body, "云端写入暂时失败，请稍后重试");
    if (!isSyncEntity(body)
      || body.entityType !== local.entityType
      || body.entityId !== local.entityId) {
      throw new Error("云端写入响应格式无效，请稍后重试");
    }
    return body;
  }

  private restoreFromRemote(entities: SyncEntity[], preferredPlanId?: string): SyncResult {
    const state = this.stateFromRemote(entities, preferredPlanId);
    const planEntity = entities.find((entity) => entity.entityType === "learning-plan" && entity.entityId === state.plan.id)!;
    const recordEntities = entities
      .filter((entity) => entity.entityType === "daily-record")
      .filter((entity) => (entity.value as { planId?: string }).planId === state.plan.id);
    const metadata: PlanSyncMetadata = { planId: state.plan.id, entities: {} };
    for (const entity of [planEntity, ...recordEntities]) {
      metadata.entities[metadataKey(entity)] = { revision: entity.revision, fingerprint: fingerprint(entity.value) };
    }
    this.saveMetadata(metadata);
    return { state, uploaded: 0, downloaded: 1 + recordEntities.length };
  }

  private stateFromRemote(entities: SyncEntity[], preferredPlanId?: string): LearningState {
    const planEntity = entities
      .filter((entity) => entity.entityType === "learning-plan")
      .filter((entity) => !preferredPlanId || entity.entityId === preferredPlanId)
      .filter((entity) => preferredPlanId || !(entity.value as LearningPlan).archivedAt)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!planEntity) throw new Error("云端没有可恢复的学习计划");
    const plan = planEntity.value as LearningPlan;
    const recordEntities = entities
      .filter((entity) => entity.entityType === "daily-record")
      .filter((entity) => (entity.value as { planId?: string }).planId === plan.id);
    const days = recordEntities.map((entity) => (entity.value as { record: DailyLearningRecord }).record).sort((left, right) => left.day - right.day);
    if (days.length === 0) throw new Error("云端计划缺少每日学习记录");
    return this.validateState({
      version: 3,
      plan,
      currentDay: days.find((day) => day.status === "active")?.day ?? days.at(-1)!.day,
      days,
    });
  }

  private loadMetadata(planId: string): PlanSyncMetadata {
    try {
      const parsed = JSON.parse(this.storage.getItem(SYNC_METADATA_KEY) ?? "null") as Partial<SyncMetadata> | Partial<LegacySyncMetadata> | null;
      if (parsed?.version === 2 && parsed.plans && typeof parsed.plans === "object") {
        return { planId, entities: parsed.plans[planId] ?? {} };
      }
      if (parsed?.version === 1 && parsed.planId === planId && parsed.entities && typeof parsed.entities === "object") {
        return { planId, entities: parsed.entities };
      }
    } catch {
      // Corrupt sync metadata can be discarded without touching learning data.
    }
    return { planId, entities: {} };
  }

  private saveMetadata(metadata: PlanSyncMetadata): void {
    let plans: SyncMetadata["plans"] = {};
    try {
      const parsed = JSON.parse(this.storage.getItem(SYNC_METADATA_KEY) ?? "null") as Partial<SyncMetadata> | Partial<LegacySyncMetadata> | null;
      if (parsed?.version === 2 && parsed.plans && typeof parsed.plans === "object") plans = parsed.plans;
      if (parsed?.version === 1 && typeof parsed.planId === "string" && parsed.entities && typeof parsed.entities === "object") {
        plans = { [parsed.planId]: parsed.entities };
      }
    } catch {
      // Corrupt metadata is replaced; learning data remains untouched.
    }
    this.storage.setItem(SYNC_METADATA_KEY, JSON.stringify({
      version: 2,
      plans: { ...plans, [metadata.planId]: metadata.entities },
    } satisfies SyncMetadata));
  }

  private validateState(state: LearningState): LearningState {
    const parsed = parseLearningState(JSON.stringify(state));
    if (!parsed.state) throw new Error("云端学习记录未通过完整校验");
    return parsed.state;
  }
}
