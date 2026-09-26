import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  onTaskViewed: vi.fn(),
}));

vi.mock("../../../apps/api/src/database", () => ({
  default: {
    query: {
      integrationTable: {
        findMany: (...args: unknown[]) => mocks.findMany(...args),
      },
    },
  },
}));

vi.mock("../../../apps/api/src/events", () => ({
  subscribeToEvent: vi.fn(),
}));

const { notifyTaskViewed, registerPlugin } = await import(
  "../../../apps/api/src/plugins/registry"
);

registerPlugin({
  type: "test-provider",
  name: "Test provider",
  onTaskViewed: (...args) => mocks.onTaskViewed(...args),
  validateConfig: async () => ({ valid: true }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([
    {
      id: "integration-1",
      projectId: "project-1",
      type: "test-provider",
      config: "{}",
    },
  ]);
});

describe("notifyTaskViewed", () => {
  it("notifies providers once per task within the refresh interval", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    notifyTaskViewed({ taskId: "task-throttle", projectId: "project-1" });
    notifyTaskViewed({ taskId: "task-throttle", projectId: "project-1" });

    await vi.waitFor(() => expect(mocks.onTaskViewed).toHaveBeenCalledTimes(1));
    expect(mocks.onTaskViewed).toHaveBeenCalledWith(
      { taskId: "task-throttle", projectId: "project-1" },
      { integrationId: "integration-1", projectId: "project-1", config: {} },
    );
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
  });

  it("does not propagate provider failures to the caller", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.onTaskViewed.mockRejectedValueOnce(new Error("provider down"));

    expect(() =>
      notifyTaskViewed({ taskId: "task-failure", projectId: "project-1" }),
    ).not.toThrow();
    await vi.waitFor(() => expect(mocks.onTaskViewed).toHaveBeenCalledTimes(1));
  });
});
