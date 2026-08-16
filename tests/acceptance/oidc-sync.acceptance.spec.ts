import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { initializeLearningState } from "../../src/learning-state";
import { generateLearningPlan } from "../../src/planner";

const ACTIVE_STATES_KEY = "ai-learning-os-active-states-v1";
const CURRENT_STATE_KEY = "ai-learning-os-state-v3";
const email = process.env.AI_LEARNING_ACCEPTANCE_EMAIL;
const password = process.env.AI_LEARNING_ACCEPTANCE_PASSWORD;
const disposableAccount = process.env.AI_LEARNING_ACCEPTANCE_DISPOSABLE_ACCOUNT === "true";
const issuerOrigin = process.env.AI_LEARNING_ACCEPTANCE_ISSUER_ORIGIN ?? "http://127.0.0.1:5556";

function requireAcceptanceEnvironment(): { email: string; password: string } {
  if (!email || !password || !disposableAccount) {
    throw new Error(
      "OIDC acceptance requires runtime email/password and AI_LEARNING_ACCEPTANCE_DISPOSABLE_ACCOUNT=true for a dedicated disposable dev account.",
    );
  }
  return { email, password };
}

async function login(page: Page, credentials: { email: string; password: string }): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name: "登录并同步" }).click();
  await expect.poll(() => new URL(page.url()).origin).toBe(issuerOrigin);
  await page.locator('input[name="login"]').fill(credentials.email);
  await page.locator('input[name="password"]').fill(credentials.password);
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  await expect(page.getByText("已登录", { exact: true }).first()).toBeVisible();
}

async function syncNow(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "立即同步" }).first();
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator(".storage-notice").first()).toContainText(/同步完成|本地与云端进度已一致/);
}

async function seedSyntheticGoal(page: Page, state: ReturnType<typeof initializeLearningState>): Promise<void> {
  await page.evaluate(({ activeKey, currentKey, value }) => {
    localStorage.setItem(activeKey, JSON.stringify({ selectedPlanId: value.plan.id, states: [value] }));
    localStorage.setItem(currentKey, JSON.stringify(value));
  }, { activeKey: ACTIVE_STATES_KEY, currentKey: CURRENT_STATE_KEY, value: state });
  await page.reload();
  await expect(page.getByRole("heading", { name: state.plan.goal.subject, exact: true })).toBeVisible();
}

async function closeContext(context: BrowserContext | undefined): Promise<void> {
  if (context) await context.close().catch(() => undefined);
}

async function deleteDisposableAccount(page: Page): Promise<void> {
  if (await page.getByRole("link", { name: "登录并同步" }).isVisible().catch(() => false)) return;
  await page.getByRole("button", { name: "删除账号", exact: true }).click();
  await page.getByRole("button", { name: "永久删除账号" }).click();
  await expect(page.getByRole("link", { name: "登录并同步" })).toBeVisible();
}

test("OIDC callback establishes two sessions and synchronizes a browser edit", async ({ browser }) => {
  const credentials = requireAcceptanceEnvironment();
  const runId = Date.now().toString(36);
  const subject = `浏览器同步验收-${runId}`;
  const state = initializeLearningState(generateLearningPlan({
    subject,
    currentLevel: "仅用于自动化验收的合成起点",
    targetOutcome: "证明两个隔离浏览器会话能够同步同一条合成任务进度",
    dailyMinutes: 30,
    durationWeeks: 1,
  }));
  let firstContext: BrowserContext | undefined;
  let secondContext: BrowserContext | undefined;
  let firstPage: Page | undefined;
  let accountDeleted = false;

  try {
    firstContext = await browser.newContext();
    firstPage = await firstContext.newPage();
    await login(firstPage, credentials);
    await seedSyntheticGoal(firstPage, state);
    await syncNow(firstPage);

    secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await login(secondPage, credentials);
    await syncNow(secondPage);
    await expect(secondPage.getByRole("heading", { name: subject, exact: true })).toBeVisible();

    await firstPage.locator("#task-day-1-diagnose > button.task").click();
    await expect(firstPage.locator("#task-day-1-diagnose")).toHaveClass(/done/);
    await syncNow(firstPage);
    await syncNow(secondPage);
    await expect(secondPage.locator("#task-day-1-diagnose")).toHaveClass(/done/);

    // This must be a dedicated disposable identity. Cleanup through the product
    // prevents synthetic records and sessions accumulating in the shared dev DB.
    await deleteDisposableAccount(firstPage);
    accountDeleted = true;
  } finally {
    if (firstPage && !accountDeleted) await deleteDisposableAccount(firstPage).catch(() => undefined);
    await closeContext(secondContext);
    await closeContext(firstContext);
  }
});
