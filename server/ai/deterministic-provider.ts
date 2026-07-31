import { generateLearningPlan } from "../../src/planner";
import type { LearningGoal } from "../../src/types";
import type { ModelProvider, StructuredGenerationRequest, StructuredGenerationResult } from "./model-provider";

export class DeterministicPlannerProvider implements ModelProvider {
  readonly id = "deterministic-development";
  readonly isAiEnabled = false;

  async generateStructured<T>(request: StructuredGenerationRequest): Promise<StructuredGenerationResult<T>> {
    const goal = JSON.parse(request.input) as LearningGoal;
    const plan = generateLearningPlan(goal);
    return {
      value: { stages: plan.stages, today: plan.today } as T,
      model: this.id,
    };
  }
}
