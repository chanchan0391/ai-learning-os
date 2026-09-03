import axe from "axe-core";
import { expect, test, type Page } from "@playwright/test";
import { initializeLearningState } from "../../src/learning-state";
import { generateLearningPlan } from "../../src/planner";

const ACTIVE_STATES_KEY = "ai-learning-os-active-states-v1";
const STORAGE_KEY = "ai-learning-os-state-v3";

interface AxeViolation {
  id: string;
  impact: string | null;
  nodes: Array<{ target: string[]; failureSummary?: string }>;
}

async function expectNoAccessibilityViolations(page: Page) {
  await page.route("**/__test__/axe.js", (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: axe.source,
  }));
  await page.addScriptTag({ url: "/__test__/axe.js" });
  const violations = await page.evaluate(async () => {
    const axeApi = (window as typeof window & {
      axe: { run: (context?: Document) => Promise<{ violations: AxeViolation[] }> };
    }).axe;
    return (await axeApi.run(document)).violations;
  });

  const evidence = violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    targets: nodes.map(({ target }) => target),
  }));
  expect(evidence, JSON.stringify(evidence, null, 2)).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/session", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: "Authentication required" }),
  }));
});

test("onboarding has no detectable browser accessibility violations", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await expect(page.getByRole("heading", { level: 1 })).toContainText("把想学的事");

  await expectNoAccessibilityViolations(page);
});

test("populated learning dashboard has no detectable browser accessibility violations", async ({ page }) => {
  const state = initializeLearningState(generateLearningPlan({
    subject: "AI Agent 工程",
    currentLevel: "Java 高级工程师",
    targetOutcome: "独立交付企业级 Agent 应用",
    dailyMinutes: 60,
    durationWeeks: 12,
  }, new Date("2026-08-31T10:00:00.000Z")));
  const collection = JSON.stringify({ selectedPlanId: state.plan.id, states: [state] });

  await page.addInitScript(({ activeStatesKey, currentStateKey, collectionJson, stateJson }) => {
    localStorage.setItem(activeStatesKey, collectionJson);
    localStorage.setItem(currentStateKey, stateJson);
  }, {
    activeStatesKey: ACTIVE_STATES_KEY,
    currentStateKey: STORAGE_KEY,
    collectionJson: collection,
    stateJson: JSON.stringify(state),
  });
  await page.goto("/", { waitUntil: "load" });
  await expect(page.getByRole("heading", { level: 1, name: "AI Agent 工程" })).toBeVisible();

  await expectNoAccessibilityViolations(page);
});
