import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const rulesPath = join(repositoryRoot, "deploy/dev/prometheus-alert-rules.yml");
const rules = readFileSync(rulesPath, "utf8");

function alertBlock(name: string) {
  const match = rules.match(new RegExp(`      - alert: ${name}\\n([\\s\\S]*?)(?=\\n      - alert:|$)`));
  expect(match, `missing alert ${name}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("dev Prometheus operations alert rules", () => {
  it("covers missing collection and both crash evidence paths", () => {
    expect(alertBlock("AiLearningOsOperationsMetricsMissing")).toContain(
      "expr: absent(ai_learning_os_application_monitor_last_success_unixtime)\n        for: 15m",
    );
    expect(alertBlock("AiLearningOsUnexpectedServiceExit")).toContain(
      "expr: increase(ai_learning_os_service_unexpected_exits_total[10m]) > 0",
    );
    expect(alertBlock("AiLearningOsUnobservedServiceExit")).toContain(
      "expr: ai_learning_os_service_unobserved_exits > 0\n        for: 10m",
    );
  });

  it.each([
    ["Application", "application", "15m", "900", "critical"],
    ["Backup", "backup", "45m", "2700", "critical"],
    ["HostCapacity", "host_capacity", "45m", "2700", "warning"],
  ])("enforces the %s monitor startup grace and stale threshold", (alertName, metricName, startupGrace, staleSeconds, severity) => {
    const metric = `ai_learning_os_${metricName}_monitor_last_success_unixtime`;
    expect(alertBlock(`AiLearningOs${alertName}MonitorNeverSucceeded`)).toContain(
      `expr: ${metric} == 0\n        for: ${startupGrace}`,
    );
    const stale = alertBlock(`AiLearningOs${alertName}MonitorStale`);
    expect(stale).toContain(`expr: ${metric} > 0 and (time() - ${metric}) > ${staleSeconds}`);
    expect(stale).toContain(`severity: ${severity}`);
  });

  it("allows one weekly restore interval plus two days before paging", () => {
    const metric = "ai_learning_os_restore_drill_last_success_unixtime";
    expect(alertBlock("AiLearningOsRestoreDrillNeverSucceeded")).toContain(
      `expr: ${metric} == 0\n        for: 9d`,
    );
    expect(alertBlock("AiLearningOsRestoreDrillStale")).toContain(
      `expr: ${metric} > 0 and (time() - ${metric}) > 777600\n        for: 1h`,
    );
  });

  it("keeps alert labels low-cardinality and descriptions content-free", () => {
    expect(rules.match(/      - alert:/g)).toHaveLength(11);
    expect(rules).not.toMatch(/\{[^}]*=~?[^}]*\}/);
    expect(rules).not.toMatch(/user|account|goal|artifact|request[_ -]?id/i);
  });
});
