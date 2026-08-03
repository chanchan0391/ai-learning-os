import { isLearningPlanComplete, parseLearningState, type ParsedLearningState } from "./learning-state";
import type { LearningState } from "./types";

export const CURRENT_LEARNING_STATE_KEY = "ai-learning-os-state-v3";
export const PREVIOUS_LEARNING_STATE_KEY = "ai-learning-os-state-v2";
export const LEGACY_LEARNING_PLAN_KEY = "ai-learning-os-plan-v1";
export const ARCHIVED_LEARNING_STATES_KEY = "ai-learning-os-archived-states-v1";
export const ACTIVE_LEARNING_STATES_KEY = "ai-learning-os-active-states-v1";
export const PORTFOLIO_DAILY_BUDGET_KEY = "ai-learning-os-portfolio-daily-budget-v1";

const ALL_LEARNING_STORAGE_KEYS = [
  CURRENT_LEARNING_STATE_KEY,
  PREVIOUS_LEARNING_STATE_KEY,
  LEGACY_LEARNING_PLAN_KEY,
  ARCHIVED_LEARNING_STATES_KEY,
  ACTIVE_LEARNING_STATES_KEY,
  PORTFOLIO_DAILY_BUDGET_KEY,
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

export interface PortfolioMergeResult {
  activeAdded: number;
  archivedAdded: number;
  skipped: number;
}

export interface PortfolioGoalSummary {
  planId: string;
  subject: string;
}

export interface PortfolioMergePreview {
  activeToAdd: PortfolioGoalSummary[];
  archivedToAdd: PortfolioGoalSummary[];
  skipped: PortfolioGoalSummary[];
  localActiveOnly: PortfolioGoalSummary[];
  localArchivedOnly: PortfolioGoalSummary[];
}

function summarizeState(state: LearningState): PortfolioGoalSummary {
  return { planId: state.plan.id, subject: state.plan.goal.subject };
}

export function previewPortfolioMerge(
  localActive: LearningState[],
  localArchived: ArchivedLearningState[],
  importedActive: LearningState[],
  importedArchived: ArchivedLearningState[],
): PortfolioMergePreview {
  const localIds = new Set([
    ...localActive.map((state) => state.plan.id),
    ...localArchived.map((entry) => entry.state.plan.id),
  ]);
  const importedIds = new Set([
    ...importedActive.map((state) => state.plan.id),
    ...importedArchived.map((entry) => entry.state.plan.id),
  ]);
  const skipped = [
    ...importedActive.filter((state) => localIds.has(state.plan.id)).map(summarizeState),
    ...importedArchived.filter((entry) => localIds.has(entry.state.plan.id)).map((entry) => summarizeState(entry.state)),
  ];

  return {
    activeToAdd: importedActive.filter((state) => !localIds.has(state.plan.id)).map(summarizeState),
    archivedToAdd: importedArchived.filter((entry) => !localIds.has(entry.state.plan.id)).map((entry) => summarizeState(entry.state)),
    skipped,
    localActiveOnly: localActive.filter((state) => !importedIds.has(state.plan.id)).map(summarizeState),
    localArchivedOnly: localArchived.filter((entry) => !importedIds.has(entry.state.plan.id)).map((entry) => summarizeState(entry.state)),
  };
}

export interface LearningStateRepository {
  load(now?: Date): ParsedLearningState;
  loadActive(): LearningState[];
  replaceActive(states: LearningState[]): LearningState[];
  selectActive(planId: string): LearningState;
  deselectActive(): void;
  loadArchived(): ArchivedLearningState[];
  loadDailyBudget(): number | null;
  saveDailyBudget(minutes: number | null): void;
  mergeArchived(entries: ArchivedLearningState[]): ArchivedLearningState[];
  mergePortfolioMissing(states: LearningState[], archived: ArchivedLearningState[]): PortfolioMergeResult;
  replacePortfolio(states: LearningState[], archived: ArchivedLearningState[], selectedPlanId: string | null, dailyBudgetMinutes: number | null): void;
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
      const collection = this.readActiveCollection();
      if (collection) {
        if (!collection.selectedPlanId) return { state: null, status: "empty" };
        const selected = collection.states.find((state) => state.plan.id === collection.selectedPlanId);
        if (!selected) {
          this.writeActiveCollection({ selectedPlanId: null, states: collection.states });
          this.removeCurrentKeys();
          return { state: null, status: "recovered" };
        }
        this.storage.setItem(CURRENT_LEARNING_STATE_KEY, JSON.stringify(selected));
        return { state: selected, status: "valid" };
      }
      const source = this.firstStoredValue();
      const result = parseLearningState(source, now);
      if (result.state && result.status === "migrated") {
        this.save(result.state);
        this.removeLegacyKeys();
      } else if (result.state) {
        this.save(result.state);
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
    const collection = this.readActiveCollection() ?? { selectedPlanId: null, states: [] };
    const states = [state, ...collection.states.filter((item) => item.plan.id !== state.plan.id)];
    this.writeActiveCollection({ selectedPlanId: state.plan.id, states });
  }

  loadActive(): LearningState[] {
    try {
      const collection = this.readActiveCollection();
      if (collection) return structuredClone(collection.states);
      const current = this.load().state;
      return current ? [structuredClone(current)] : [];
    } catch {
      return [];
    }
  }

  replaceActive(states: LearningState[]): LearningState[] {
    const collection = this.readActiveCollection() ?? { selectedPlanId: null, states: [] };
    const uniqueStates = states.filter((state, index) => states.findIndex((item) => item.plan.id === state.plan.id) === index);
    const selectedPlanId = collection.selectedPlanId && uniqueStates.some((state) => state.plan.id === collection.selectedPlanId)
      ? collection.selectedPlanId
      : null;
    this.writeActiveCollection({ selectedPlanId, states: uniqueStates });
    const selected = uniqueStates.find((state) => state.plan.id === selectedPlanId);
    if (selected) this.storage.setItem(CURRENT_LEARNING_STATE_KEY, JSON.stringify(selected));
    else this.removeCurrentKeys();
    return structuredClone(uniqueStates);
  }

  selectActive(planId: string): LearningState {
    const collection = this.readActiveCollection();
    if (!collection) throw new Error("找不到要切换的学习目标");
    const state = collection.states.find((item) => item.plan.id === planId);
    if (!state) throw new Error("找不到要切换的学习目标");
    this.writeActiveCollection({ selectedPlanId: planId, states: collection.states });
    this.storage.setItem(CURRENT_LEARNING_STATE_KEY, JSON.stringify(state));
    return structuredClone(state);
  }

  deselectActive(): void {
    const collection = this.readActiveCollection() ?? { selectedPlanId: null, states: [] };
    this.writeActiveCollection({ ...collection, selectedPlanId: null });
    this.removeCurrentKeys();
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

  loadDailyBudget(): number | null {
    try {
      const raw = this.storage.getItem(PORTFOLIO_DAILY_BUDGET_KEY);
      if (raw === null) return null;
      const minutes = Number(raw);
      if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) {
        this.storage.removeItem(PORTFOLIO_DAILY_BUDGET_KEY);
        return null;
      }
      return minutes;
    } catch {
      return null;
    }
  }

  saveDailyBudget(minutes: number | null): void {
    if (minutes === null) {
      this.storage.removeItem(PORTFOLIO_DAILY_BUDGET_KEY);
      return;
    }
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) {
      throw new RangeError("每日总时间预算必须是 15–1440 分钟的整数");
    }
    this.storage.setItem(PORTFOLIO_DAILY_BUDGET_KEY, String(minutes));
  }

  mergeArchived(entries: ArchivedLearningState[]): ArchivedLearningState[] {
    const existing = this.loadArchived();
    const existingIds = new Set(existing.map((entry) => entry.state.plan.id));
    const additions = entries.filter((entry) => !existingIds.has(entry.state.plan.id));
    const merged = [...existing, ...additions].sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
    if (additions.length > 0) this.storage.setItem(ARCHIVED_LEARNING_STATES_KEY, JSON.stringify(merged));
    return merged;
  }

  mergePortfolioMissing(states: LearningState[], archived: ArchivedLearningState[]): PortfolioMergeResult {
    const localActive = this.loadActive();
    const localArchived = this.loadArchived();
    const knownIds = new Set([
      ...localActive.map((state) => state.plan.id),
      ...localArchived.map((entry) => entry.state.plan.id),
    ]);
    const activeAdditions = states.filter((state) => {
      if (knownIds.has(state.plan.id)) return false;
      knownIds.add(state.plan.id);
      return true;
    });
    const archivedAdditions = archived.filter((entry) => {
      if (knownIds.has(entry.state.plan.id)) return false;
      knownIds.add(entry.state.plan.id);
      return true;
    });

    if (activeAdditions.length > 0) this.replaceActive([...localActive, ...activeAdditions]);
    if (archivedAdditions.length > 0) this.mergeArchived(archivedAdditions);
    return {
      activeAdded: activeAdditions.length,
      archivedAdded: archivedAdditions.length,
      skipped: states.length + archived.length - activeAdditions.length - archivedAdditions.length,
    };
  }

  replacePortfolio(
    states: LearningState[],
    archived: ArchivedLearningState[],
    selectedPlanId: string | null,
    dailyBudgetMinutes: number | null,
  ): void {
    this.writeActiveCollection({ selectedPlanId, states: structuredClone(states) });
    if (archived.length > 0) this.storage.setItem(ARCHIVED_LEARNING_STATES_KEY, JSON.stringify(archived));
    else this.storage.removeItem(ARCHIVED_LEARNING_STATES_KEY);
    if (dailyBudgetMinutes === null) this.storage.removeItem(PORTFOLIO_DAILY_BUDGET_KEY);
    else this.storage.setItem(PORTFOLIO_DAILY_BUDGET_KEY, String(dailyBudgetMinutes));
    const selected = states.find((state) => state.plan.id === selectedPlanId);
    if (selected) this.storage.setItem(CURRENT_LEARNING_STATE_KEY, JSON.stringify(selected));
    else this.removeCurrentKeys();
    this.removeLegacyKeys();
  }

  archiveCompleted(state: LearningState, now = new Date()): ArchivedLearningState[] {
    if (!isLearningPlanComplete(state)) {
      throw new Error("只有完成全部计划学习日后才能归档目标");
    }
    const archived = [
      { archivedAt: now.toISOString(), state: structuredClone(state) },
      ...this.loadArchived().filter((entry) => entry.state.plan.id !== state.plan.id),
    ];
    this.storage.setItem(ARCHIVED_LEARNING_STATES_KEY, JSON.stringify(archived));
    const collection = this.readActiveCollection();
    const remaining = collection?.states.filter((item) => item.plan.id !== state.plan.id) ?? [];
    const nextPlanId = remaining[0]?.plan.id ?? null;
    this.writeActiveCollection({ selectedPlanId: nextPlanId, states: remaining });
    if (remaining[0]) this.storage.setItem(CURRENT_LEARNING_STATE_KEY, JSON.stringify(remaining[0]));
    else this.removeCurrentKeys();
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

  private readActiveCollection(): { selectedPlanId: string | null; states: LearningState[] } | null {
    const raw = this.storage.getItem(ACTIVE_LEARNING_STATES_KEY);
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw) as { selectedPlanId?: unknown; states?: unknown };
      if (!value || !Array.isArray(value.states) || (value.selectedPlanId !== null && typeof value.selectedPlanId !== "string")) {
        throw new TypeError("Invalid active learning-state collection");
      }
      const states = value.states.flatMap((candidate) => {
        const parsed = parseLearningState(JSON.stringify(candidate));
        return parsed.state ? [parsed.state] : [];
      });
      const uniqueStates = states.filter((state, index) => states.findIndex((item) => item.plan.id === state.plan.id) === index);
      return { selectedPlanId: value.selectedPlanId as string | null, states: uniqueStates };
    } catch {
      this.storage.removeItem(ACTIVE_LEARNING_STATES_KEY);
      return null;
    }
  }

  private writeActiveCollection(collection: { selectedPlanId: string | null; states: LearningState[] }): void {
    this.storage.setItem(ACTIVE_LEARNING_STATES_KEY, JSON.stringify(collection));
  }
}
