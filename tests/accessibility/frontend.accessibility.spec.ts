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

async function expectVisibleKeyboardFocus(page: Page) {
  const focus = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(focus).toMatchObject({ focusVisible: true, outlineStyle: "solid" });
  expect(focus?.outlineWidth).toBeGreaterThanOrEqual(3);
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

test("onboarding exposes a logical keyboard-only focus order", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await expect(page.getByRole("link", { name: "登录并同步" })).toBeVisible();

  const expectedOrder = [
    page.getByRole("link", { name: "登录并同步" }),
    page.getByRole("button", { name: "导入学习记录" }),
    page.getByRole("textbox", { name: "我想学习" }),
    page.getByRole("textbox", { name: "我现在的基础" }),
    page.getByRole("textbox", { name: "我希望最终能够" }),
    page.getByRole("spinbutton", { name: "每天投入" }),
    page.getByRole("spinbutton", { name: "学习周期" }),
    page.getByRole("button", { name: /生成我的学习路线/ }),
  ];
  for (const control of expectedOrder) {
    await page.keyboard.press("Tab");
    await expect(control).toBeFocused();
    await expectVisibleKeyboardFocus(page);
  }
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

test("dashboard destructive confirmation traps focus and restores its trigger", async ({ page }) => {
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
  await expect(page.getByRole("link", { name: "登录并同步" })).toBeVisible();

  for (const control of [
    page.getByRole("link", { name: "登录并同步" }),
    page.getByRole("button", { name: "导出全部数据" }),
    page.getByRole("button", { name: "导入学习记录" }),
    page.getByRole("button", { name: "导出学习记录", exact: true }),
    page.getByRole("button", { name: "删除本地数据" }),
  ]) {
    await page.keyboard.press("Tab");
    await expect(control).toBeFocused();
  }
  await expectVisibleKeyboardFocus(page);
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("alertdialog", { name: "删除当前浏览器中的学习数据？" });
  const cancel = dialog.getByRole("button", { name: "取消" });
  const confirm = dialog.getByRole("button", { name: "确认删除" });
  await expect(cancel).toBeFocused();
  await expectVisibleKeyboardFocus(page);
  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Escape");

  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "删除本地数据" })).toBeFocused();
  await expectVisibleKeyboardFocus(page);
});
