import { isLearningPlanComplete, parseLearningState, type ParsedLearningState } from "./learning-state";
import type { LearningState } from "./types";

export const CURRENT_LEARNING_STATE_KEY = "ai-learning-os-state-v3";
export const PREVIOUS_LEARNING_STATE_KEY = "ai-learning-os-state-v2";
export const LEGACY_LEARNING_PLAN_KEY = "ai-learning-os-plan-v1";
export const ARCHIVED_LEARNING_STATES_KEY = "ai-learning-os-archived-states-v1";
export const ACTIVE_LEARNING_STATES_KEY = "ai-learning-os-active-states-v1";
export const PORTFOLIO_DAILY_BUDGET_KEY = "ai-learning-os-portfolio-daily-budget-v1";
export const PORTFOLIO_STORAGE_TRANSACTION_KEY = "ai-learning-os-portfolio-transaction-v1";

const ALL_LEARNING_STORAGE_KEYS = [
  CURRENT_LEARNING_STATE_KEY,
  PREVIOUS_LEARNING_STATE_KEY,
  LEGACY_LEARNING_PLAN_KEY,
  ARCHIVED_LEARNING_STATES_KEY,
  ACTIVE_LEARNING_STATES_KEY,
  PORTFOLIO_DAILY_BUDGET_KEY,
  PORTFOLIO_STORAGE_TRANSACTION_KEY,
] as const;

const CURRENT_AND_LEGACY_KEYS = [
  CURRENT_LEARNING_STATE_KEY,
  PREVIOUS_LEARNING_STATE_KEY,
  LEGACY_LEARNING_PLAN_KEY,
] as const;

const PORTFOLIO_TRANSACTION_KEYS = [
  ACTIVE_LEARNING_STATES_KEY,
  ARCHIVED_LEARNING_STATES_KEY,
  PORTFOLIO_DAILY_BUDGET_KEY,
] as const;

type PortfolioTransactionKey = typeof PORTFOLIO_TRANSACTION_KEYS[number];

interface PortfolioStorageTransaction {
  version: 1;
  phase: "pending" | "done";
  snapshots: Partial<Record<PortfolioTransactionKey, string | null>>;
}

export class LearningStorageError extends Error {
  constructor(options?: ErrorOptions) {
    super("无法把更改保存到此浏览器；更改未应用。请释放存储空间或关闭无痕/严格隐私模式后重试。", options);
    this.name = "LearningStorageError";
  }
}

export interface ArchivedLearningState {
  archivedAt: string;
  state: LearningState;
}

export interface PortfolioMergeResult {
  activeAdded: number;
  archivedAdded: number;
  skipped: number;
  replaced?: number;
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
  conflicts: PortfolioVersionConflict[];
}

export interface PortfolioGoalVersionSummary extends PortfolioGoalSummary {
  location: "active" | "archived";
  currentDay: number;
  completedDays: number;
  completedTasks: number;
  totalTasks: number;
  latestActivityAt: string;
}

export interface PortfolioVersionConflict {
  planId: string;
  subject: string;
  local: PortfolioGoalVersionSummary;
  imported: PortfolioGoalVersionSummary;
}

function summarizeState(state: LearningState): PortfolioGoalSummary {
  return { planId: state.plan.id, subject: state.plan.goal.subject };
}

function summarizeVersion(state: LearningState, location: "active" | "archived"): PortfolioGoalVersionSummary {
  const completedDays = state.days.filter((day) => day.status === "completed");
  const activityDates = [
    state.plan.createdAt,
    ...state.days.map((day) => day.completedAt ?? day.date),
    ...(state.plan.notes ?? []).map((note) => note.updatedAt),
    ...(state.plan.retrospectives ?? []).map((item) => item.updatedAt),
  ];
  return {
    ...summarizeState(state),
    location,
    currentDay: state.currentDay,
    completedDays: completedDays.length,
    completedTasks: state.days.flatMap((day) => day.tasks).filter((task) => task.completed).length,
    totalTasks: state.days.flatMap((day) => day.tasks).length,
    latestActivityAt: activityDates.sort().at(-1) ?? state.plan.createdAt,
  };
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
  const localVersions = new Map<string, PortfolioGoalVersionSummary>([
    ...localActive.map((state) => [state.plan.id, summarizeVersion(state, "active")] as const),
    ...localArchived.map((entry) => [entry.state.plan.id, summarizeVersion(entry.state, "archived")] as const),
  ]);
  const importedVersions = [
    ...importedActive.map((state) => summarizeVersion(state, "active")),
    ...importedArchived.map((entry) => summarizeVersion(entry.state, "archived")),
  ];

  return {
    activeToAdd: importedActive.filter((state) => !localIds.has(state.plan.id)).map(summarizeState),
    archivedToAdd: importedArchived.filter((entry) => !localIds.has(entry.state.plan.id)).map((entry) => summarizeState(entry.state)),
    skipped,
    localActiveOnly: localActive.filter((state) => !importedIds.has(state.plan.id)).map(summarizeState),
    localArchivedOnly: localArchived.filter((entry) => !importedIds.has(entry.state.plan.id)).map((entry) => summarizeState(entry.state)),
    conflicts: importedVersions.flatMap((imported) => {
      const local = localVersions.get(imported.planId);
      return local ? [{ planId: imported.planId, subject: imported.subject, local, imported }] : [];
    }),
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
  applyPortfolioImport(states: LearningState[], archived: ArchivedLearningState[], replacePlanIds: string[]): PortfolioMergeResult;
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
        this.writeCurrentMirror(selected);
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
    const collection = this.readActiveCollection() ?? { selectedPlanId: null, states: [] };
    const states = [state, ...collection.states.filter((item) => item.plan.id !== state.plan.id)];
    // The collection is canonical. Commit it before the compatibility mirror so
    // a mirror failure can never make a successful edit disappear on reload.
    this.writeActiveCollection({ selectedPlanId: state.plan.id, states });
    this.writeCurrentMirror(state);
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
    if (selected) this.writeCurrentMirror(selected);
    else this.removeCurrentKeys();
    return structuredClone(uniqueStates);
  }

  selectActive(planId: string): LearningState {
    const collection = this.readActiveCollection();
    if (!collection) throw new Error("找不到要切换的学习目标");
    const state = collection.states.find((item) => item.plan.id === planId);
    if (!state) throw new Error("找不到要切换的学习目标");
    this.writeActiveCollection({ selectedPlanId: planId, states: collection.states });
    this.writeCurrentMirror(state);
    return structuredClone(state);
  }

  deselectActive(): void {
    const collection = this.readActiveCollection() ?? { selectedPlanId: null, states: [] };
    this.writeActiveCollection({ ...collection, selectedPlanId: null });
    this.removeCurrentKeys();
  }

  loadArchived(): ArchivedLearningState[] {
    try {
      this.recoverPortfolioTransaction();
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
      this.recoverPortfolioTransaction();
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
    try {
      if (minutes === null) {
        this.storage.removeItem(PORTFOLIO_DAILY_BUDGET_KEY);
        return;
      }
      if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) {
        throw new RangeError("每日总时间预算必须是 15–1440 分钟的整数");
      }
      this.storage.setItem(PORTFOLIO_DAILY_BUDGET_KEY, String(minutes));
    } catch (error) {
      if (error instanceof RangeError) throw error;
      throw new LearningStorageError({ cause: error });
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

    if (activeAdditions.length > 0 || archivedAdditions.length > 0) {
      this.runPortfolioTransaction([ACTIVE_LEARNING_STATES_KEY, ARCHIVED_LEARNING_STATES_KEY], () => {
        if (activeAdditions.length > 0) {
          const selectedPlanId = this.readSelectedPlanIdWithoutRecovery();
          this.writeActiveCollection({ selectedPlanId, states: [...localActive, ...activeAdditions] });
        }
        if (archivedAdditions.length > 0) {
          const nextArchived = [...localArchived, ...archivedAdditions]
            .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
          this.storage.setItem(ARCHIVED_LEARNING_STATES_KEY, JSON.stringify(nextArchived));
        }
      });
    }
    return {
      activeAdded: activeAdditions.length,
      archivedAdded: archivedAdditions.length,
      skipped: states.length + archived.length - activeAdditions.length - archivedAdditions.length,
    };
  }

  applyPortfolioImport(states: LearningState[], archived: ArchivedLearningState[], replacePlanIds: string[]): PortfolioMergeResult {
    const replaceIds = new Set(replacePlanIds);
    const localActive = this.loadActive();
    const localArchived = this.loadArchived();
    const localIds = new Set([
      ...localActive.map((state) => state.plan.id),
      ...localArchived.map((entry) => entry.state.plan.id),
    ]);
    const importedActive = states.filter((state) => !localIds.has(state.plan.id) || replaceIds.has(state.plan.id));
    const importedArchived = archived.filter((entry) => !localIds.has(entry.state.plan.id) || replaceIds.has(entry.state.plan.id));
    const appliedIds = new Set([
      ...importedActive.map((state) => state.plan.id),
      ...importedArchived.map((entry) => entry.state.plan.id),
    ]);
    const nextActive = [
      ...localActive.filter((state) => !appliedIds.has(state.plan.id)),
      ...importedActive,
    ];
    const nextArchived = [
      ...localArchived.filter((entry) => !appliedIds.has(entry.state.plan.id)),
      ...importedArchived,
    ].sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
    const selectedPlanId = this.readActiveCollection()?.selectedPlanId ?? null;
    this.runPortfolioTransaction([ACTIVE_LEARNING_STATES_KEY, ARCHIVED_LEARNING_STATES_KEY], () => {
      this.writeActiveCollection({
        selectedPlanId: selectedPlanId && nextActive.some((state) => state.plan.id === selectedPlanId) ? selectedPlanId : null,
        states: structuredClone(nextActive),
      });
      if (nextArchived.length > 0) this.storage.setItem(ARCHIVED_LEARNING_STATES_KEY, JSON.stringify(nextArchived));
      else this.storage.removeItem(ARCHIVED_LEARNING_STATES_KEY);
    });
    const selected = nextActive.find((state) => state.plan.id === selectedPlanId);
    if (selected) this.writeCurrentMirror(selected);
    else this.removeCurrentKeys();

    return {
      activeAdded: states.filter((state) => !localIds.has(state.plan.id)).length,
      archivedAdded: archived.filter((entry) => !localIds.has(entry.state.plan.id)).length,
      replaced: appliedIds.size - states.filter((state) => !localIds.has(state.plan.id)).length
        - archived.filter((entry) => !localIds.has(entry.state.plan.id)).length,
      skipped: states.length + archived.length - appliedIds.size,
    };
  }

  replacePortfolio(
    states: LearningState[],
    archived: ArchivedLearningState[],
    selectedPlanId: string | null,
    dailyBudgetMinutes: number | null,
  ): void {
    this.runPortfolioTransaction(PORTFOLIO_TRANSACTION_KEYS, () => {
      this.writeActiveCollection({ selectedPlanId, states: structuredClone(states) });
      if (archived.length > 0) this.storage.setItem(ARCHIVED_LEARNING_STATES_KEY, JSON.stringify(archived));
      else this.storage.removeItem(ARCHIVED_LEARNING_STATES_KEY);
      if (dailyBudgetMinutes === null) this.storage.removeItem(PORTFOLIO_DAILY_BUDGET_KEY);
      else this.storage.setItem(PORTFOLIO_DAILY_BUDGET_KEY, String(dailyBudgetMinutes));
    });
    const selected = states.find((state) => state.plan.id === selectedPlanId);
    if (selected) this.writeCurrentMirror(selected);
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
    const collection = this.readActiveCollection();
    const remaining = collection?.states.filter((item) => item.plan.id !== state.plan.id) ?? [];
    const nextPlanId = remaining[0]?.plan.id ?? null;
    this.runPortfolioTransaction([ARCHIVED_LEARNING_STATES_KEY, ACTIVE_LEARNING_STATES_KEY], () => {
      this.storage.setItem(ARCHIVED_LEARNING_STATES_KEY, JSON.stringify(archived));
      this.writeActiveCollection({ selectedPlanId: nextPlanId, states: remaining });
    });
    if (remaining[0]) this.writeCurrentMirror(remaining[0]);
    else this.removeCurrentKeys();
    return archived;
  }

  restoreArchived(planId: string): LearningState {
    const archived = this.loadArchived();
    const entry = archived.find((item) => item.state.plan.id === planId);
    if (!entry) throw new Error("找不到要恢复的已归档目标");
    const remaining = archived.filter((item) => item.state.plan.id !== planId);
    const collection = this.readActiveCollection() ?? { selectedPlanId: null, states: [] };
    const states = [entry.state, ...collection.states.filter((item) => item.plan.id !== planId)];
    this.runPortfolioTransaction([ACTIVE_LEARNING_STATES_KEY, ARCHIVED_LEARNING_STATES_KEY], () => {
      this.writeActiveCollection({ selectedPlanId: planId, states });
      if (remaining.length > 0) this.storage.setItem(ARCHIVED_LEARNING_STATES_KEY, JSON.stringify(remaining));
      else this.storage.removeItem(ARCHIVED_LEARNING_STATES_KEY);
    });
    this.writeCurrentMirror(entry.state);
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
    this.recoverPortfolioTransaction();
    return this.readActiveCollectionWithoutRecovery();
  }

  private readSelectedPlanIdWithoutRecovery(): string | null {
    return this.readActiveCollectionWithoutRecovery()?.selectedPlanId ?? null;
  }

  private readActiveCollectionWithoutRecovery(): { selectedPlanId: string | null; states: LearningState[] } | null {
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
    try {
      this.storage.setItem(ACTIVE_LEARNING_STATES_KEY, JSON.stringify(collection));
    } catch (error) {
      throw new LearningStorageError({ cause: error });
    }
  }

  private writeCurrentMirror(state: LearningState): void {
    try {
      this.storage.setItem(CURRENT_LEARNING_STATE_KEY, JSON.stringify(state));
    } catch {
      // The active collection is the canonical durable record. This mirror is
      // retained only for backwards compatibility and recovery from old data.
    }
  }

  private runPortfolioTransaction<T>(keys: readonly PortfolioTransactionKey[], operation: () => T): T {
    try {
      this.recoverPortfolioTransaction();
      const snapshots = Object.fromEntries(keys.map((key) => [key, this.storage.getItem(key)])) as Partial<
        Record<PortfolioTransactionKey, string | null>
      >;
      const transaction: PortfolioStorageTransaction = { version: 1, phase: "pending", snapshots };
      this.storage.setItem(PORTFOLIO_STORAGE_TRANSACTION_KEY, JSON.stringify(transaction));
      try {
        const result = operation();
        this.storage.setItem(PORTFOLIO_STORAGE_TRANSACTION_KEY, JSON.stringify({ ...transaction, phase: "done" }));
        this.removeTransactionJournalBestEffort();
        return result;
      } catch (error) {
        this.restorePortfolioSnapshots(snapshots);
        throw error;
      }
    } catch (error) {
      if (error instanceof LearningStorageError) throw error;
      throw new LearningStorageError({ cause: error });
    }
  }

  private recoverPortfolioTransaction(): void {
    const raw = this.storage.getItem(PORTFOLIO_STORAGE_TRANSACTION_KEY);
    if (raw === null) return;
    let transaction: PortfolioStorageTransaction;
    try {
      transaction = JSON.parse(raw) as PortfolioStorageTransaction;
      const keys = Object.keys(transaction.snapshots ?? {});
      if (transaction.version !== 1 || !["pending", "done"].includes(transaction.phase)
        || keys.some((key) => !PORTFOLIO_TRANSACTION_KEYS.includes(key as PortfolioTransactionKey))
        || Object.values(transaction.snapshots ?? {}).some((value) => value !== null && typeof value !== "string")) {
        throw new TypeError("Invalid portfolio storage transaction");
      }
    } catch {
      this.removeTransactionJournalBestEffort();
      return;
    }
    if (transaction.phase === "pending") this.restorePortfolioSnapshots(transaction.snapshots);
    else this.removeTransactionJournalBestEffort();
  }

  private restorePortfolioSnapshots(snapshots: Partial<Record<PortfolioTransactionKey, string | null>>): void {
    // Removing the journal and changed values first releases enough quota to put
    // the previously durable snapshots back, even when a larger import failed.
    this.removeTransactionJournalBestEffort();
    const keys = Object.keys(snapshots) as PortfolioTransactionKey[];
    for (const key of keys) this.storage.removeItem(key);
    for (const key of keys) {
      const value = snapshots[key];
      if (value !== null && value !== undefined) this.storage.setItem(key, value);
    }
  }

  private removeTransactionJournalBestEffort(): void {
    try {
      this.storage.removeItem(PORTFOLIO_STORAGE_TRANSACTION_KEY);
    } catch {
      // A completed journal is harmless and will be removed on the next access.
    }
  }
}
