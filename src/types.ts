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

export interface StageLearningNote {
  id: string;
  stageId: string;
  title: string;
  content: string;
  sourceDays: number[];
  updatedAt: string;
}

export interface StageRetrospective {
  id: string;
  stageId: string;
  goalReflection: string;
  representativeArtifact: string;
  transferableSkills: string;
  nextApplication: string;
  sourceDays: number[];
  updatedAt: string;
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
  /** Present only in the synchronized representation of a locally archived goal. */
  archivedAt?: string;
  goal: LearningGoal;
  stages: LearningStage[];
  today: DailyTask[];
  notes?: StageLearningNote[];
  retrospectives?: StageRetrospective[];
}

export type TaskDifficulty = "too-easy" | "just-right" | "too-hard";

export interface DailyFeedback {
  difficulty: TaskDifficulty;
  reflection: string;
}

export interface LearningTaskArtifact {
  teachingSession?: TeachingSession;
  understandingResponses?: Record<string, string>;
  submission?: string;
  evaluation?: EvaluationResult;
  reviewPerformance?: ReviewPerformance;
  stageMasteryRemediation?: StageMasteryRemediationSource;
}

/** Links a follow-up practice back to the stage evidence gap that created it. */
export interface StageMasteryRemediationSource {
  stageId: string;
  sourceDay: number;
  sourceTaskId?: string;
  sourceNextAction: string;
}

export type ReviewRecall = "forgot" | "effortful" | "easy";

export interface ReviewPerformance {
  sourceDays: number[];
  recall: ReviewRecall;
  assessment?: ReviewAssessment;
}

export interface ReviewPromptItem {
  sourceDay: number;
  nextAction: string;
  misconceptions: string[];
}

export interface ReviewAssessmentRequest {
  goal: LearningGoal;
  items: ReviewPromptItem[];
  answer: string;
}

export interface ReviewAssessment {
  answer: string;
  score: number;
  recall: ReviewRecall;
  evidence: string;
  feedback: string;
}

export interface DailyLearningRecord {
  day: number;
  date: string;
  tasks: DailyTask[];
  status: "active" | "completed";
  completedAt?: string;
  feedback?: DailyFeedback;
  artifacts: Record<string, LearningTaskArtifact>;
}

export interface LearningState {
  version: 3;
  plan: LearningPlan;
  currentDay: number;
  days: DailyLearningRecord[];
}

export interface TeachingSessionRequest {
  goal: LearningGoal;
  task: DailyTask;
  learnerContext: {
    knownConcepts: string[];
    recentErrors: string[];
  };
}

export interface UnderstandingCheck {
  id: string;
  prompt: string;
  expectedSignals: string[];
}

export interface TeachingSession {
  concept: string;
  explanation: string;
  workedExample: string;
  understandingChecks: UnderstandingCheck[];
  practicePrompt: string;
  completionSignals: string[];
}

export interface EvaluationRequest {
  goal: LearningGoal;
  task: DailyTask;
  submission: string;
}

export type EvaluationDimension = "understanding" | "application" | "evidence" | "reflection";

export interface RubricScore {
  dimension: EvaluationDimension;
  score: number;
  evidence: string;
  feedback: string;
}

export type MasteryLevel = "needs-support" | "developing" | "ready";

export interface EvaluationResult {
  rubric: RubricScore[];
  totalScore: number;
  masteryLevel: MasteryLevel;
  misconceptions: string[];
  nextAction: string;
}

export type LearningInterruptionReason = "inactivity" | "repeated-difficulty" | "both";

export interface LearningInterruption {
  reason: LearningInterruptionReason;
  inactiveDays: number;
  recentDifficultDays: number;
  lastActiveDate: string;
}

export interface RecoveryPlanRequest {
  goal: LearningGoal;
  currentTask: DailyTask;
  interruption: LearningInterruption;
}

export interface RecoveryStep {
  id: string;
  title: string;
  description: string;
  minutes: number;
}

export interface RecoveryPlan {
  headline: string;
  acknowledgement: string;
  totalMinutes: number;
  steps: RecoveryStep[];
  nextCheckIn: string;
}
