export const AGENT_INPUT_LIMITS = {
  taskIdCharacters: 200,
  taskTitleCharacters: 300,
  taskDescriptionCharacters: 4_000,
  learnerContextItems: 50,
  learnerContextItemCharacters: 1_000,
  submissionCharacters: 20_000,
  reviewItems: 50,
  reviewMisconceptionsPerItem: 20,
  reviewTextCharacters: 2_000,
  reviewAnswerCharacters: 20_000,
} as const;

/**
 * Model output is untrusted even when a provider claims to enforce JSON Schema.
 * These limits protect persisted learning state and also give compatible
 * providers an explicit generation contract.
 */
export const AGENT_OUTPUT_LIMITS = {
  idCharacters: 200,
  titleCharacters: 300,
  shortTextCharacters: 1_000,
  longTextCharacters: 8_000,
  plannerStages: 52,
  plannerTasks: 32,
  teacherSignalsPerCheck: 10,
  teacherCompletionSignals: 20,
  evaluationMisconceptions: 20,
} as const;
