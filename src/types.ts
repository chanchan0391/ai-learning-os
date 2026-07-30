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

