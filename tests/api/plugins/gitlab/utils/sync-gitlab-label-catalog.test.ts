import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existingLabels: [] as Array<{ id: string; name: string; color: string }>,
  insertedValues: [] as Array<Record<string, unknown>>,
  published: vi.fn(),
  listLabels: vi.fn(),
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
              id: `catalog-label-${index}`,
            }));
          },
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

vi.mock("../../../../../apps/api/src/events", () => ({
  publishEvent: (...args: unknown[]) => mocks.published(...args),
}));

vi.mock("../../../../../apps/api/src/plugins/gitlab/utils/gitlab-api", () => ({
  createGitlabClient: () => ({ listLabels: (...args: unknown[]) => mocks.listLabels(...args) }),
}));

const { syncGitlabLabelCatalog } = await import(
  "../../../../../apps/api/src/plugins/gitlab/utils/sync-gitlab-label-catalog"
);

beforeEach(() => {
  mocks.existingLabels = [];
  mocks.insertedValues = [];
  mocks.published.mockReset();
  mocks.listLabels.mockResolvedValue([
    { name: "backend", color: "#123456" },
    { name: "customer-visible", color: "abcdef" },
    { name: "priority:high", color: "#ff0000" },
    { name: "status:in-progress", color: "#0000ff" },
  ]);
});

describe("syncGitlabLabelCatalog", () => {
  it("imports all project labels for filters except status and priority metadata", async () => {
    await syncGitlabLabelCatalog(
      {
        baseUrl: "https://gitlab.example.com",
        accessToken: "token",
        projectPath: "acme/web",
      },
      "project-1",
      "workspace-1",
    );

    expect(mocks.listLabels).toHaveBeenCalledWith("acme/web");
    expect(mocks.insertedValues).toEqual([
      {
        name: "backend",
        color: "#123456",
        taskId: null,
        workspaceId: "workspace-1",
      },
      {
        name: "customer-visible",
        color: "#abcdef",
        taskId: null,
        workspaceId: "workspace-1",
      },
    ]);
    expect(mocks.published).toHaveBeenCalledWith("workspace.labels_updated", {
      projectId: "project-1",
      workspaceId: "workspace-1",
    });
  });
});