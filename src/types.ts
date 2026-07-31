export interface LearningGoal {
  subject: string;
  currentLevel: string;
  targetOutcome: string;
  dailyMinutes: number;
  durationWeeks: number;
}

export interface LearningStage {
  id: string;
  title: string;
  outcome: string;
  startWeek: number;
  endWeek: number;
}

export interface DailyTask {
  id: string;
  type: "diagnose" | "learn" | "practice" | "reflect";
  title: string;
  description: string;
  minutes: number;
  completed: boolean;
}

export interface LearningPlan {
  id: string;
  createdAt: string;
  goal: LearningGoal;
  stages: LearningStage[];
  today: DailyTask[];
}

export type TaskDifficulty = "too-easy" | "just-right" | "too-hard";

export interface DailyFeedback {
  difficulty: TaskDifficulty;
  reflection: string;
}

export interface DailyLearningRecord {
  day: number;
  date: string;
  tasks: DailyTask[];
  status: "active" | "completed";
  completedAt?: string;
  feedback?: DailyFeedback;
}

export interface LearningState {
  version: 2;
  plan: LearningPlan;
  currentDay: number;
  days: DailyLearningRecord[];
}
