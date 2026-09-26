import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProjectTaskRelation } from "@/fetchers/task-relation/get-project-task-relations";
import type Task from "@/types/task";

const updateTaskStatus = vi.hoisted(() => vi.fn());

vi.mock("@/fetchers/task/update-task-status", () => ({
  default: updateTaskStatus,
}));

import { useUpdateTaskStatus } from "./use-update-task-status";

const relation = {
  id: "relation",
  sourceTaskId: "parent",
  targetTaskId: "child",
  relationType: "subtask",
  createdAt: "2025-01-01T00:00:00.000Z",
  sourceTask: {
    id: "parent",
    title: "Parent",
    status: "in-progress",
    priority: null,
    number: 1,
    projectId: "project",
    userId: null,
    assigneeName: null,
    assigneeImage: null,
  },
  targetTask: {
    id: "child",
    title: "Child",
    status: "in-progress",
    priority: null,
    number: 2,
    projectId: "project",
    userId: null,
    assigneeName: null,
    assigneeImage: null,
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useUpdateTaskStatus", () => {
  it("updates the child status in cached parent-task relations", async () => {
    updateTaskStatus.mockResolvedValue({ id: "child", status: "done" });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["task-relations", "parent"], [relation]);
    queryClient.setQueryData(
      ["task-relations", "project", "project"],
      [relation],
    );
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUpdateTaskStatus(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: "child",
        projectId: "project",
        status: "done",
      } as Task);
    });

    const parentRelations = queryClient.getQueryData<ProjectTaskRelation[]>([
      "task-relations",
      "parent",
    ]);
    const projectRelations = queryClient.getQueryData<ProjectTaskRelation[]>([
      "task-relations",
      "project",
      "project",
    ]);
    expect(parentRelations?.[0].targetTask?.status).toBe("done");
    expect(projectRelations?.[0].targetTask?.status).toBe("done");
    expect(parentRelations?.[0].sourceTask?.status).toBe("in-progress");
  });
});
