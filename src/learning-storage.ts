import { parseLearningState, type ParsedLearningState } from "./learning-state";
import type { LearningState } from "./types";

export const CURRENT_LEARNING_STATE_KEY = "ai-learning-os-state-v3";
export const PREVIOUS_LEARNING_STATE_KEY = "ai-learning-os-state-v2";
export const LEGACY_LEARNING_PLAN_KEY = "ai-learning-os-plan-v1";

const ALL_LEARNING_STORAGE_KEYS = [
  CURRENT_LEARNING_STATE_KEY,
  PREVIOUS_LEARNING_STATE_KEY,
  LEGACY_LEARNING_PLAN_KEY,
] as const;

export interface LearningStateRepository {
  load(now?: Date): ParsedLearningState;
  save(state: LearningState): void;
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
        this.clear();
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

  clear(): void {
    for (const key of ALL_LEARNING_STORAGE_KEYS) this.storage.removeItem(key);
  }

  private firstStoredValue(): string | null {
    for (const key of ALL_LEARNING_STORAGE_KEYS) {
      const value = this.storage.getItem(key);
      if (value !== null) return value;
    }
    return null;
  }

  private removeLegacyKeys(): void {
    this.storage.removeItem(PREVIOUS_LEARNING_STATE_KEY);
    this.storage.removeItem(LEGACY_LEARNING_PLAN_KEY);
  }
}
