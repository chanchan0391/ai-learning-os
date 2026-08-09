import { randomUUID } from "node:crypto";
import type { DailyLearningRecord, LearningPlan } from "../../src/types";

export interface SyncPrincipal {
  userId: string;
  deviceId: string;
}

export interface DailyRecordSyncValue {
  planId: string;
  record: DailyLearningRecord;
}

export type SyncEntityType = "learning-plan" | "daily-record";
export type SyncEntityValue = LearningPlan | DailyRecordSyncValue;

export interface SyncWriteRequest<T> {
  operationId: string;
  entityId: string;
  baseRevision: number | null;
  value: T;
}

export interface SyncEntity<T = SyncEntityValue> {
  entityType: SyncEntityType;
  entityId: string;
  revision: number;
  updatedAt: string;
  value: T;
}

export interface SyncChanges {
  changes: SyncEntity[];
  cursor: string;
  hasMore: boolean;
}

export const MAX_SYNC_IDENTIFIER_LENGTH = 256;
export const MAX_SYNC_PAGE_BYTES = 8 * 1024 * 1024;

export interface SyncStore {
  putPlan(principal: SyncPrincipal, request: SyncWriteRequest<LearningPlan>): SyncEntity<LearningPlan> | Promise<SyncEntity<LearningPlan>>;
  putDailyRecord(principal: SyncPrincipal, request: SyncWriteRequest<DailyRecordSyncValue>): SyncEntity<DailyRecordSyncValue> | Promise<SyncEntity<DailyRecordSyncValue>>;
  getChanges(principal: SyncPrincipal, cursor?: string): SyncChanges | Promise<SyncChanges>;
}

export class SyncConflictError extends Error {
  readonly code = "revision-conflict";

  constructor(readonly current: SyncEntity | null) {
    super("The entity changed after the supplied base revision");
    this.name = "SyncConflictError";
  }
}

export class SyncRequestError extends Error {
  constructor(readonly code: "invalid-cursor" | "idempotency-mismatch" | "missing-plan" | "unknown-principal" | "entity-too-large", message: string) {
    super(message);
    this.name = "SyncRequestError";
  }
}

/** Selects a cursor-safe prefix whose encoded entities fit the response budget. */
export function boundedSyncPage<T extends SyncEntity>(
  candidates: readonly T[],
  pageSize: number,
  maxBytes = MAX_SYNC_PAGE_BYTES,
): T[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("Sync page byte limit must be a positive integer");
  const page: T[] = [];
  let encodedBytes = 0;
  for (const entity of candidates.slice(0, pageSize)) {
    const entityBytes = Buffer.byteLength(JSON.stringify(entity), "utf8") + (page.length > 0 ? 1 : 0);
    if (entityBytes > maxBytes && page.length === 0) {
      throw new SyncRequestError("entity-too-large", "A synchronized entity exceeds the response size limit");
    }
    if (encodedBytes + entityBytes > maxBytes) break;
    page.push(entity);
    encodedBytes += entityBytes;
  }
  return page;
}

interface StoredEntity extends SyncEntity {
  userId: string;
  sequence: number;
}

interface StoredOperation {
  fingerprint: string;
  result: SyncEntity;
}

interface CursorPosition {
  userId: string;
  sequence: number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function requireSyncIdentity(principal: SyncPrincipal): void {
  if (!isBoundedIdentifier(principal.userId) || !isBoundedIdentifier(principal.deviceId)) {
    throw new TypeError("An authenticated user and device are required");
  }
}

export function requireSyncWriteRequest(request: SyncWriteRequest<unknown>): void {
  if (!isBoundedIdentifier(request.operationId) || !isBoundedIdentifier(request.entityId)) {
    throw new TypeError(`Operation and entity IDs must contain 1-${MAX_SYNC_IDENTIFIER_LENGTH} characters`);
  }
  if (request.baseRevision !== null && (!Number.isInteger(request.baseRevision) || request.baseRevision < 1)) {
    throw new TypeError("Base revision must be null or a positive integer");
  }
}

export function requireSyncCursor(cursor: string): void {
  if (!isBoundedIdentifier(cursor)) {
    throw new SyncRequestError("invalid-cursor", `The sync cursor must contain 1-${MAX_SYNC_IDENTIFIER_LENGTH} characters`);
  }
}

function isBoundedIdentifier(value: string): boolean {
  const length = value.trim().length;
  return length > 0 && length <= MAX_SYNC_IDENTIFIER_LENGTH;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function syncOperationFingerprint(entityType: SyncEntityType, request: SyncWriteRequest<unknown>): string {
  return JSON.stringify(canonicalize({ entityType, ...request }));
}

/**
 * Provider-neutral synchronization domain store.
 *
 * Authentication stays outside this class: callers must resolve a trusted
 * principal before every operation. Every key and idempotency record is scoped
 * by that principal's user ID so client-supplied ownership fields are never used.
 */
export class InMemorySyncStore {
  private readonly entities = new Map<string, StoredEntity>();
  private readonly operations = new Map<string, StoredOperation>();
  private readonly cursors = new Map<string, CursorPosition>();
  private sequence = 0;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly createCursor: () => string = () => randomUUID(),
    private readonly pageSize = 250,
    private readonly pageByteLimit = MAX_SYNC_PAGE_BYTES,
  ) {
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new TypeError("Sync page size must be a positive integer");
    if (!Number.isSafeInteger(pageByteLimit) || pageByteLimit <= 0) throw new TypeError("Sync page byte limit must be a positive integer");
  }

  putPlan(principal: SyncPrincipal, request: SyncWriteRequest<LearningPlan>): SyncEntity<LearningPlan> {
    return this.write(principal, "learning-plan", request) as SyncEntity<LearningPlan>;
  }

  putDailyRecord(principal: SyncPrincipal, request: SyncWriteRequest<DailyRecordSyncValue>): SyncEntity<DailyRecordSyncValue> {
    requireSyncIdentity(principal);
    const planKey = this.entityKey(principal.userId, "learning-plan", request.value.planId);
    if (!this.entities.has(planKey)) {
      throw new SyncRequestError("missing-plan", "The daily record's plan does not belong to the authenticated user");
    }
    return this.write(principal, "daily-record", request) as SyncEntity<DailyRecordSyncValue>;
  }

  getChanges(principal: SyncPrincipal, cursor?: string): SyncChanges {
    requireSyncIdentity(principal);
    let afterSequence = 0;
    if (cursor) {
      requireSyncCursor(cursor);
      const position = this.cursors.get(cursor);
      if (!position || position.userId !== principal.userId) {
        throw new SyncRequestError("invalid-cursor", "The sync cursor is invalid for the authenticated user");
      }
      afterSequence = position.sequence;
    }

    const matching = [...this.entities.values()]
      .filter((entity) => entity.userId === principal.userId && entity.sequence > afterSequence)
      .sort((left, right) => left.sequence - right.sequence);
    const candidates = matching.slice(0, this.pageSize)
      .map(({ userId: _userId, sequence: _sequence, ...entity }) => clone(entity));
    const changes = boundedSyncPage(candidates, this.pageSize, this.pageByteLimit);
    const page = matching.slice(0, changes.length);
    const latestSequence = page.at(-1)?.sequence ?? afterSequence;
    const nextCursor = this.createCursor();
    this.cursors.set(nextCursor, { userId: principal.userId, sequence: latestSequence });
    return { changes, cursor: nextCursor, hasMore: matching.length > changes.length };
  }

  private write<T>(principal: SyncPrincipal, entityType: SyncEntityType, request: SyncWriteRequest<T>): SyncEntity<T> {
    requireSyncIdentity(principal);
    requireSyncWriteRequest(request);
    const operationKey = `${principal.userId}\0${request.operationId}`;
    const fingerprint = syncOperationFingerprint(entityType, request);
    const previousOperation = this.operations.get(operationKey);
    if (previousOperation) {
      if (previousOperation.fingerprint !== fingerprint) {
        throw new SyncRequestError("idempotency-mismatch", "The operation ID was already used for different content");
      }
      return clone(previousOperation.result) as SyncEntity<T>;
    }

    const key = this.entityKey(principal.userId, entityType, request.entityId);
    const current = this.entities.get(key);
    const expectedRevision = current?.revision ?? null;
    if (request.baseRevision !== expectedRevision) {
      if (current) {
        const { userId: _userId, sequence: _sequence, ...currentEntity } = current;
        throw new SyncConflictError(clone(currentEntity));
      }
      throw new SyncConflictError(null);
    }

    this.sequence += 1;
    const stored: StoredEntity = {
      userId: principal.userId,
      sequence: this.sequence,
      entityType,
      entityId: request.entityId,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: this.now().toISOString(),
      value: clone(request.value) as SyncEntityValue,
    };
    this.entities.set(key, stored);
    const { userId: _userId, sequence: _sequence, ...result } = stored;
    this.operations.set(operationKey, { fingerprint, result: clone(result) });
    return clone(result) as SyncEntity<T>;
  }

  private entityKey(userId: string, entityType: SyncEntityType, entityId: string): string {
    return `${userId}\0${entityType}\0${entityId}`;
  }
}
