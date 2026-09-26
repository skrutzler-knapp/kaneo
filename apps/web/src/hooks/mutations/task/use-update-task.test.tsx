import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProjectTaskRelation } from "@/fetchers/task-relation/get-project-task-relations";
import type Task from "@/types/task";

const updateTask = vi.hoisted(() => vi.fn());

vi.mock("@/fetchers/task/update-task", () => ({
  default: updateTask,
}));

import { useUpdateTask } from "./use-update-task";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useUpdateTask", () => {
  it("updates child statuses in cached parent relations after board changes", async () => {
    updateTask.mockResolvedValue({ id: "child", status: "done" });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
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
        isCompleted: false,
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
        isCompleted: false,
        priority: null,
        number: 2,
        projectId: "project",
        userId: null,
        assigneeName: null,
        assigneeImage: null,
      },
    } satisfies ProjectTaskRelation;
    queryClient.setQueryData(["task-relations", "parent"], [relation]);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUpdateTask(), { wrapper });

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
    expect(parentRelations?.[0].targetTask?.status).toBe("done");
    expect(parentRelations?.[0].sourceTask?.status).toBe("in-progress");
  });
});
