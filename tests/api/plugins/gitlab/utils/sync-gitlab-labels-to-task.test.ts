import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existingLabels: [] as Array<{
    id: string;
    name: string;
    color: string;
  }>,
  insertedValues: [] as Array<Record<string, unknown>>,
  published: [] as Array<[string, Record<string, unknown>]>,
}));

vi.mock("../../../../../apps/api/src/database", () => ({
  default: {
    query: {
      labelTable: {
        findMany: async () => mocks.existingLabels,
      },
    },
    insert: () => ({
      values: (values: Array<Record<string, unknown>>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            mocks.insertedValues.push(...values);
            return values.map((value, index) => ({
              ...value,
              id: `new-label-${index}`,
            }));
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => undefined }),
    }),
    delete: () => ({ where: async () => undefined }),
  },
}));

vi.mock("../../../../../apps/api/src/events", () => ({
  publishEvent: async (name: string, payload: Record<string, unknown>) => {
    mocks.published.push([name, payload]);
  },
}));

const { syncGitlabLabelsToTask } = await import(
  "../../../../../apps/api/src/plugins/gitlab/utils/sync-gitlab-labels-to-task"
);

beforeEach(() => {
  mocks.existingLabels = [];
  mocks.insertedValues = [];
  mocks.published = [];
});

describe("syncGitlabLabelsToTask", () => {
  it("imports every custom GitLab label and leaves status and priority as metadata", async () => {
    await syncGitlabLabelsToTask("task-1", "project-1", "workspace-1", [
      { title: "backend", color: "#123456" },
      { title: "customer-visible", color: "#abcdef" },
      { title: "priority:high", color: "#ff0000" },
      { title: "status:in-progress", color: "#0000ff" },
    ]);

    expect(mocks.insertedValues).toEqual([
      {
        name: "backend",
        color: "#123456",
        taskId: "task-1",
        workspaceId: "workspace-1",
      },
      {
        name: "customer-visible",
        color: "#abcdef",
        taskId: "task-1",
        workspaceId: "workspace-1",
      },
    ]);
    expect(mocks.published.map(([name]) => name)).toEqual([
      "task.label_created",
      "task.label_created",
    ]);
  });

  it("removes custom labels absent from the full GitLab label snapshot", async () => {
    mocks.existingLabels = [
      { id: "old-custom", name: "old-label", color: "#123456" },
      { id: "old-status", name: "status:done", color: "#6B7280" },
    ];

    await syncGitlabLabelsToTask(
      "task-1",
      "project-1",
      "workspace-1",
      [
        { title: "current-label", color: "#abcdef" },
        { title: "status:done", color: "#6B7280" },
      ],
      ["old-label"],
    );

    expect(mocks.published.map(([name]) => name)).toEqual([
      "task.label_created",
      "task.label_unassigned",
    ]);
    expect(mocks.published[1][1].label).toMatchObject({
      id: "old-custom",
      name: "old-label",
    });
  });

  it("preserves labels missing from a partial GitLab snapshot unless explicitly removed", async () => {
    mocks.existingLabels = [
      { id: "selected-a", name: "selected-a", color: "#123456" },
      { id: "selected-b", name: "selected-b", color: "#abcdef" },
    ];

    await syncGitlabLabelsToTask("task-1", "project-1", "workspace-1", [
      { title: "selected-a", color: "#123456" },
    ]);

    expect(mocks.published).toHaveLength(0);
  });
});