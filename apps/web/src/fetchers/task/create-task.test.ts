import { beforeEach, describe, expect, it, vi } from "vitest";
import createTask from "./create-task";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock("@kaneo/libs", () => ({
  client: {
    task: {
      ":projectId": {
        $post: mocks.post,
      },
    },
  },
}));

describe("createTask", () => {
  beforeEach(() => {
    mocks.post.mockReset();
    mocks.post.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "task-1" }),
    });
  });

  it.each([undefined, ""])(
    "omits the assignee when userId is %s",
    async (userId) => {
      await createTask(
        "Unassigned task",
        "",
        "project-1",
        userId,
        "to-do",
        undefined,
        undefined,
        "no-priority",
      );

      expect(mocks.post).toHaveBeenCalledWith({
        json: {
          title: "Unassigned task",
          description: "",
          status: "to-do",
          startDate: undefined,
          dueDate: undefined,
          priority: "no-priority",
        },
        param: { projectId: "project-1" },
      });
    },
  );

  it("preserves an assigned userId", async () => {
    await createTask(
      "Assigned task",
      "",
      "project-1",
      "user-1",
      "to-do",
      undefined,
      undefined,
      "no-priority",
    );

    expect(mocks.post).toHaveBeenCalledWith(
      expect.objectContaining({
        json: expect.objectContaining({ userId: "user-1" }),
      }),
    );
  });

  it("sends a parent task ID when creating a subtask", async () => {
    await createTask(
      "Subtask",
      "",
      "project-1",
      undefined,
      "to-do",
      undefined,
      undefined,
      "no-priority",
      undefined,
      "parent-task-1",
      ["label-1", "label-2"],
    );

    expect(mocks.post).toHaveBeenCalledWith(
      expect.objectContaining({
        json: expect.objectContaining({
          parentTaskId: "parent-task-1",
          labelIds: ["label-1", "label-2"],
        }),
      }),
    );
  });
});
