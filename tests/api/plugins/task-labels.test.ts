import { describe, expect, it, vi } from "vite-plus/test";
import { getCustomTaskLabelNames } from "../../../apps/api/src/plugins/task-labels";

const labelFindMany = vi.hoisted(() => vi.fn());

vi.mock("../../../apps/api/src/database", () => ({
  default: {
    query: {
      labelTable: {
        findMany: (...args: unknown[]) => labelFindMany(...args),
      },
    },
  },
}));

describe("getCustomTaskLabelNames", () => {
  it("excludes task-field labels, including comma-joined names", async () => {
    labelFindMany.mockResolvedValue([
      { name: "backend" },
      { name: "status:done" },
      { name: "priority:high" },
      { name: "frontend, status:done" },
    ]);

    await expect(getCustomTaskLabelNames("task-1")).resolves.toEqual([
      "backend",
    ]);
  });
});
