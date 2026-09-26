import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  existingLabels: [] as Array<{ id: string; name: string; color: string }>,
  insertedValues: [] as Array<Record<string, unknown>>,
  updatedValues: [] as Array<Record<string, unknown>>,
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
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => mocks.updatedValues.push(values),
      }),
    }),
  },
}));

vi.mock("../../../../../apps/api/src/events", () => ({
  publishEvent: (...args: unknown[]) => mocks.published(...args),
}));

vi.mock("../../../../../apps/api/src/plugins/gitlab/utils/gitlab-api", () => ({
  createGitlabClient: () => ({
    listLabels: (...args: unknown[]) => mocks.listLabels(...args),
  }),
}));

const { ensureGitlabWorkspaceLabels, syncGitlabLabelCatalog } =
  await import("../../../../../apps/api/src/plugins/gitlab/utils/sync-gitlab-label-catalog");

beforeEach(() => {
  mocks.existingLabels = [];
  mocks.insertedValues = [];
  mocks.updatedValues = [];
  mocks.published.mockReset();
  mocks.listLabels.mockResolvedValue([
    { name: "backend", color: "#123456" },
    { name: "customer-visible", color: "abcdef" },
    { name: "priority:high", color: "#ff0000" },
    { name: "status:in-progress", color: "#0000ff" },
  ]);
});

describe("syncGitlabLabelCatalog", () => {
  it("inserts missing project labels without recoloring existing workspace labels", async () => {
    mocks.existingLabels = [
      {
        id: "label-backend",
        name: "backend",
        color: "#987654",
      },
    ];

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
        name: "customer-visible",
        color: "#abcdef",
        taskId: null,
        workspaceId: "workspace-1",
      },
    ]);
    expect(mocks.updatedValues).toEqual([]);
    expect(mocks.published).toHaveBeenCalledWith("workspace.labels_updated", {
      projectId: "project-1",
      workspaceId: "workspace-1",
    });
  });

  it("ensures only payload labels and publishes only when a label is inserted", async () => {
    mocks.existingLabels = [
      {
        id: "label-existing",
        name: "existing",
        color: "#987654",
      },
    ];
    const labels = [
      { title: "existing", color: "#123456" },
      { title: "new-label", color: "abcdef" },
      { title: "priority:high", color: "#ff0000" },
    ];

    mocks.listLabels.mockClear();
    await ensureGitlabWorkspaceLabels("project-1", "workspace-1", labels);

    expect(mocks.listLabels).not.toHaveBeenCalled();
    expect(mocks.insertedValues).toEqual([
      {
        name: "new-label",
        color: "#abcdef",
        taskId: null,
        workspaceId: "workspace-1",
      },
    ]);
    expect(mocks.updatedValues).toEqual([]);
    expect(mocks.published).toHaveBeenCalledTimes(1);

    mocks.published.mockClear();
    mocks.insertedValues = [];
    await ensureGitlabWorkspaceLabels("project-1", "workspace-1", [
      { title: "existing", color: "#ffffff" },
    ]);
    expect(mocks.published).not.toHaveBeenCalled();
    expect(mocks.updatedValues).toEqual([]);
  });
});
