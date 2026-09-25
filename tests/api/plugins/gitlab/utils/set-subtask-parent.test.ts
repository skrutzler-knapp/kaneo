import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setSubtaskParent: vi.fn(),
  listSubtaskRelations: vi.fn(),
}));

vi.mock("../../../../../apps/api/src/plugins/gitlab/utils/gitlab-api", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../../apps/api/src/plugins/gitlab/utils/gitlab-api")
  >("../../../../../apps/api/src/plugins/gitlab/utils/gitlab-api");
  return {
    ...actual,
    createGitlabClient: () => ({
      setSubtaskParent: (...args: unknown[]) => mocks.setSubtaskParent(...args),
      listSubtaskRelations: (...args: unknown[]) =>
        mocks.listSubtaskRelations(...args),
    }),
  };
});

const { GitlabApiError } = await import(
  "../../../../../apps/api/src/plugins/gitlab/utils/gitlab-api"
);
const { setGitlabSubtaskParent } = await import(
  "../../../../../apps/api/src/plugins/gitlab/utils/set-subtask-parent"
);

const config = {
  baseUrl: "https://gitlab.example.com",
  accessToken: "test-token",
  projectPath: "acme/web",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setSubtaskParent.mockResolvedValue(undefined);
  mocks.listSubtaskRelations.mockResolvedValue([]);
});

describe("setGitlabSubtaskParent", () => {
  it("delegates a normal parent assignment to the GitLab client", async () => {
    await setGitlabSubtaskParent(config, 1, 4);

    expect(mocks.setSubtaskParent).toHaveBeenCalledWith("acme/web", 1, 4);
    expect(mocks.listSubtaskRelations).not.toHaveBeenCalled();
  });

  it("accepts a concurrent duplicate only when GitLab confirms the same parent", async () => {
    mocks.setSubtaskParent.mockRejectedValue(
      new GitlabApiError("Work item(s) already assigned", 400, "HTTP_ERROR"),
    );
    mocks.listSubtaskRelations.mockResolvedValue([
      { parentIid: 1, childIid: 4 },
    ]);

    await expect(setGitlabSubtaskParent(config, 1, 4)).resolves.toBeUndefined();
    expect(mocks.listSubtaskRelations).toHaveBeenCalledWith("acme/web", [1, 4]);
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
