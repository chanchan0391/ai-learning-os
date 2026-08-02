import { parseLearningState, type ParsedLearningState } from "./learning-state";
import type { LearningState } from "./types";

export const CURRENT_LEARNING_STATE_KEY = "ai-learning-os-state-v3";
export const PREVIOUS_LEARNING_STATE_KEY = "ai-learning-os-state-v2";
export const LEGACY_LEARNING_PLAN_KEY = "ai-learning-os-plan-v1";
export const ARCHIVED_LEARNING_STATES_KEY = "ai-learning-os-archived-states-v1";

const ALL_LEARNING_STORAGE_KEYS = [
  CURRENT_LEARNING_STATE_KEY,
  PREVIOUS_LEARNING_STATE_KEY,
  LEGACY_LEARNING_PLAN_KEY,
  ARCHIVED_LEARNING_STATES_KEY,
] as const;

const CURRENT_AND_LEGACY_KEYS = [
  CURRENT_LEARNING_STATE_KEY,
  PREVIOUS_LEARNING_STATE_KEY,
  LEGACY_LEARNING_PLAN_KEY,
] as const;

export interface ArchivedLearningState {
  archivedAt: string;
  state: LearningState;
}

export interface LearningStateRepository {
  load(now?: Date): ParsedLearningState;
  loadArchived(): ArchivedLearningState[];
  mergeArchived(entries: ArchivedLearningState[]): ArchivedLearningState[];
  save(state: LearningState): void;
  archiveCompleted(state: LearningState, now?: Date): ArchivedLearningState[];
  restoreArchived(planId: string): LearningState;
  clear(): void;
}

/**
 * Browser persistence boundary for the local-first MVP.
 *
 * Migration remains a domain concern in `parseLearningState`; this adapter owns
 * storage-key discovery, promotion to the current key, and cleanup of stale data.
 */
export class BrowserLearningStateRepository implements LearningStateRepository {
  constructor(private readonly storage: Storage) {}

  load(now = new Date()): ParsedLearningState {
    try {
      const source = this.firstStoredValue();
      const result = parseLearningState(source, now);
      if (result.state && result.status === "migrated") {
        this.save(result.state);
        this.removeLegacyKeys();
      } else if (result.status === "recovered") {
        this.removeCurrentKeys();
      }
      return result;
    } catch {
      // Browsers can deny storage access (for example, strict privacy mode).
      // The app should remain usable in memory and surface a recovery notice.
      return { state: null, status: "recovered" };
    }
  }

  save(state: LearningState): void {
    this.storage.setItem(CURRENT_LEARNING_STATE_KEY, JSON.stringify(state));
  }

  loadArchived(): ArchivedLearningState[] {
    try {
      const raw = this.storage.getItem(ARCHIVED_LEARNING_STATES_KEY);
      if (raw === null) return [];
      const candidates = JSON.parse(raw) as unknown;
      if (!Array.isArray(candidates)) throw new TypeError("Archived learning states must be an array");
      return candidates.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const archivedAt = (candidate as { archivedAt?: unknown }).archivedAt;
        const state = (candidate as { state?: unknown }).state;
        if (typeof archivedAt !== "string" || Number.isNaN(Date.parse(archivedAt))) return [];
        const parsed = parseLearningState(JSON.stringify(state));
        return parsed.state ? [{ archivedAt, state: parsed.state }] : [];
      }).sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
    } catch {
      this.storage.removeItem(ARCHIVED_LEARNING_STATES_KEY);
      return [];
    }
  }

  mergeArchived(entries: ArchivedLearningState[]): ArchivedLearningState[] {
    const existing = this.loadArchived();
    const existingIds = new Set(existing.map((entry) => entry.state.plan.id));
    const additions = entries.filter((entry) => !existingIds.has(entry.state.plan.id));
    const merged = [...existing, ...additions].sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
    if (additions.length > 0) this.storage.setItem(ARCHIVED_LEARNING_STATES_KEY, JSON.stringify(merged));
    return merged;
  }

  archiveCompleted(state: LearningState, now = new Date()): ArchivedLearningState[] {
    const plannedDays = state.plan.goal.durationWeeks * 7;
    const completedDays = state.days.filter((day) => day.status === "completed").length;
    if (completedDays !== plannedDays || state.days.length !== plannedDays) {
      throw new Error("只有完成全部计划学习日后才能归档目标");
    }
    const archived = [
      { archivedAt: now.toISOString(), state: structuredClone(state) },
      ...this.loadArchived().filter((entry) => entry.state.plan.id !== state.plan.id),
    ];
    this.storage.setItem(ARCHIVED_LEARNING_STATES_KEY, JSON.stringify(archived));
    this.removeCurrentKeys();
    return archived;
  }

  restoreArchived(planId: string): LearningState {
    const archived = this.loadArchived();
    const entry = archived.find((item) => item.state.plan.id === planId);
    if (!entry) throw new Error("找不到要恢复的已归档目标");
    this.save(entry.state);
    const remaining = archived.filter((item) => item.state.plan.id !== planId);
    if (remaining.length > 0) this.storage.setItem(ARCHIVED_LEARNING_STATES_KEY, JSON.stringify(remaining));
    else this.storage.removeItem(ARCHIVED_LEARNING_STATES_KEY);
    return structuredClone(entry.state);
  }

  clear(): void {
    for (const key of ALL_LEARNING_STORAGE_KEYS) this.storage.removeItem(key);
  }

  private firstStoredValue(): string | null {
    for (const key of CURRENT_AND_LEGACY_KEYS) {
      const value = this.storage.getItem(key);
      if (value !== null) return value;
    }
    return null;
  }

  private removeLegacyKeys(): void {
    this.storage.removeItem(PREVIOUS_LEARNING_STATE_KEY);
    this.storage.removeItem(LEGACY_LEARNING_PLAN_KEY);
  }

  private removeCurrentKeys(): void {
    for (const key of CURRENT_AND_LEGACY_KEYS) this.storage.removeItem(key);
  }
}
