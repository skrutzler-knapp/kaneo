import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  findExternalLinkByTaskAndType: vi.fn(),
  syncGitlabRelationsForIssues: vi.fn(),
}));

vi.mock(
  "../../../../../apps/api/src/plugins/github/services/link-manager",
  () => ({
    findExternalLinkByTaskAndType: (...args: unknown[]) =>
      mocks.findExternalLinkByTaskAndType(...args),
  }),
);

vi.mock(
  "../../../../../apps/api/src/plugins/gitlab/utils/sync-gitlab-task-relations",
  () => ({
    syncGitlabRelationsForIssues: (...args: unknown[]) =>
      mocks.syncGitlabRelationsForIssues(...args),
  }),
);

const { handleTaskViewed } =
  await import("../../../../../apps/api/src/plugins/gitlab/events/task-viewed");

const context = {
  integrationId: "integration-1",
  projectId: "project-1",
  config: {
    baseUrl: "https://gitlab.example.com",
    accessToken: "test-token",
    projectPath: "acme/web",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleTaskViewed", () => {
  it("reconciles relations for the viewed task's linked issue", async () => {
    mocks.findExternalLinkByTaskAndType.mockResolvedValue({ externalId: "7" });

    await handleTaskViewed(
      { taskId: "task-1", projectId: "project-1" },
      context,
    );

    expect(mocks.findExternalLinkByTaskAndType).toHaveBeenCalledWith(
      "task-1",
      "integration-1",
      "issue",
    );
    expect(mocks.syncGitlabRelationsForIssues).toHaveBeenCalledWith(
      "project-1",
      "integration-1",
      "acme/web",
      [7],
    );
  });

  it("does nothing for tasks without a linked GitLab issue", async () => {
    mocks.findExternalLinkByTaskAndType.mockResolvedValue(undefined);

    await handleTaskViewed(
      { taskId: "task-1", projectId: "project-1" },
      context,
    );

    expect(mocks.syncGitlabRelationsForIssues).not.toHaveBeenCalled();
  });
});
