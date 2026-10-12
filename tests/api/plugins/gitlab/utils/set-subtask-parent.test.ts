import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  setSubtaskParent: vi.fn(),
  listSubtaskRelations: vi.fn(),
  createRelatedIssueLink: vi.fn(),
}));

vi.mock(
  "../../../../../apps/api/src/plugins/gitlab/utils/gitlab-api",
  async () => {
    const actual = await vi.importActual<
      typeof import("../../../../../apps/api/src/plugins/gitlab/utils/gitlab-api")
    >("../../../../../apps/api/src/plugins/gitlab/utils/gitlab-api");
    return {
      ...actual,
      createGitlabClient: () => ({
        setSubtaskParent: (...args: unknown[]) =>
          mocks.setSubtaskParent(...args),
        listSubtaskRelations: (...args: unknown[]) =>
          mocks.listSubtaskRelations(...args),
      }),
    };
  },
);

vi.mock(
  "../../../../../apps/api/src/plugins/gitlab/utils/create-related-issue-link",
  () => ({
    createRelatedIssueLink: (...args: unknown[]) =>
      mocks.createRelatedIssueLink(...args),
  }),
);

const { GitlabApiError } =
  await import("../../../../../apps/api/src/plugins/gitlab/utils/gitlab-api");
const { setGitlabSubtaskParent } =
  await import("../../../../../apps/api/src/plugins/gitlab/utils/set-subtask-parent");

const config = {
  baseUrl: "https://gitlab.example.com",
  accessToken: "test-token",
  projectPath: "acme/web",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setSubtaskParent.mockResolvedValue(undefined);
  mocks.listSubtaskRelations.mockResolvedValue([]);
  mocks.createRelatedIssueLink.mockResolvedValue(undefined);
});

describe("setGitlabSubtaskParent", () => {
  it("delegates a normal parent assignment to the GitLab client", async () => {
    await setGitlabSubtaskParent(config, 1, 4);

    expect(mocks.listSubtaskRelations).toHaveBeenCalledWith("acme/web", [4]);
    expect(mocks.setSubtaskParent).toHaveBeenCalledWith("acme/web", 1, 4);
    expect(mocks.createRelatedIssueLink).not.toHaveBeenCalled();
  });

  it("preserves an existing parent and links additional Kaneo parents as related", async () => {
    mocks.listSubtaskRelations.mockResolvedValue([
      { parentIid: 9, childIid: 4 },
    ]);

    await setGitlabSubtaskParent(config, 1, 4, [1, 9]);

    expect(mocks.setSubtaskParent).not.toHaveBeenCalled();
    expect(mocks.createRelatedIssueLink).toHaveBeenCalledWith(config, 1, 4);
  });

  it("reparents when the old GitLab parent is no longer a Kaneo parent", async () => {
    mocks.listSubtaskRelations.mockResolvedValue([
      { parentIid: 9, childIid: 4 },
    ]);

    await setGitlabSubtaskParent(config, 1, 4, [1]);

    expect(mocks.setSubtaskParent).toHaveBeenCalledWith("acme/web", 1, 4);
    expect(mocks.createRelatedIssueLink).not.toHaveBeenCalled();
  });

  it("accepts a concurrent duplicate only when GitLab confirms the same parent", async () => {
    mocks.setSubtaskParent.mockRejectedValue(
      new GitlabApiError("Work item(s) already assigned", 400, "HTTP_ERROR"),
    );
    mocks.listSubtaskRelations
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ parentIid: 1, childIid: 4 }]);

    await expect(setGitlabSubtaskParent(config, 1, 4)).resolves.toBeUndefined();
    expect(mocks.listSubtaskRelations).toHaveBeenNthCalledWith(
      1,
      "acme/web",
      [4],
    );
    expect(mocks.listSubtaskRelations).toHaveBeenNthCalledWith(
      2,
      "acme/web",
      [4],
    );
  });

  it("propagates an already-assigned error when the child has another parent", async () => {
    const error = new GitlabApiError(
      "Work item(s) already assigned",
      400,
      "HTTP_ERROR",
    );
    mocks.setSubtaskParent.mockRejectedValue(error);
    mocks.listSubtaskRelations.mockResolvedValue([
      { parentIid: 9, childIid: 4 },
    ]);

    await expect(setGitlabSubtaskParent(config, 1, 4)).rejects.toBe(error);
  });
});
