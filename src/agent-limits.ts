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
