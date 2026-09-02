import { expect, test } from "@playwright/test";

interface BrowserPerformanceResult {
  cumulativeLayoutShift: number;
  domContentLoadedMs: number;
  firstContentfulPaintMs: number | null;
  largestContentfulPaintMs: number | null;
  loadMs: number;
  longestTaskMs: number;
  resourceCount: number;
}

test("renders the production onboarding route within browser performance budgets", async ({ page }) => {
  const unexpectedOrigins = new Set<string>();
  page.on("request", (request) => {
    const origin = new URL(request.url()).origin;
    if (origin !== "http://127.0.0.1:8088") unexpectedOrigins.add(origin);
  });
  await page.addInitScript(() => {
    const metrics = {
      cumulativeLayoutShift: 0,
      largestContentfulPaintMs: null as number | null,
      longestTaskMs: 0,
    };
    Object.assign(window, { __aiLearningPerformanceMetrics: metrics });

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) metrics.largestContentfulPaintMs = entry.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { hadRecentInput?: boolean; value?: number }>) {
        if (!entry.hadRecentInput) metrics.cumulativeLayoutShift += entry.value ?? 0;
      }
    }).observe({ type: "layout-shift", buffered: true });

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        metrics.longestTaskMs = Math.max(metrics.longestTaskMs, entry.duration);
      }
    }).observe({ type: "longtask", buffered: true });
  });
  await page.route("**/api/auth/session", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: "Authentication required" }),
  }));

  await page.goto("/", { waitUntil: "load" });
  await expect(page.getByRole("heading", { level: 1 })).toContainText("把想学的事");
  await page.waitForFunction(() => (window as Window & {
    __aiLearningPerformanceMetrics: { largestContentfulPaintMs: number | null };
  }).__aiLearningPerformanceMetrics.largestContentfulPaintMs !== null);

  const result = await page.evaluate<BrowserPerformanceResult>(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const paint = performance.getEntriesByName("first-contentful-paint")[0];
    const observed = (window as Window & {
      __aiLearningPerformanceMetrics: {
        cumulativeLayoutShift: number;
        largestContentfulPaintMs: number | null;
        longestTaskMs: number;
      };
    }).__aiLearningPerformanceMetrics;
    return {
      ...observed,
      domContentLoadedMs: navigation.domContentLoadedEventEnd,
      firstContentfulPaintMs: paint?.startTime ?? null,
      loadMs: navigation.loadEventEnd,
      resourceCount: performance.getEntriesByType("resource").length,
    };
  });

  console.log(`Browser performance: ${JSON.stringify(result)}`);
  expect([...unexpectedOrigins]).toEqual([]);
  expect(result.resourceCount).toBeGreaterThan(0);
  expect(result.domContentLoadedMs).toBeLessThanOrEqual(2_000);
  expect(result.loadMs).toBeLessThanOrEqual(3_000);
  expect(result.firstContentfulPaintMs).not.toBeNull();
  expect(result.firstContentfulPaintMs!).toBeLessThanOrEqual(1_800);
  expect(result.largestContentfulPaintMs).not.toBeNull();
  expect(result.largestContentfulPaintMs!).toBeLessThanOrEqual(2_500);
  expect(result.cumulativeLayoutShift).toBeLessThanOrEqual(0.1);
  expect(result.longestTaskMs).toBeLessThanOrEqual(250);
});
