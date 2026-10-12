import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  findExternalLinkByTaskAndType: vi.fn(),
  listSubtaskRelations: vi.fn(),
  removeSubtaskParent: vi.fn(),
  deleteRelatedIssueLink: vi.fn(),
  recordGitlabTaskRelation: vi.fn(),
}));

vi.mock(
  "../../../../../apps/api/src/plugins/github/services/link-manager",
  () => ({
    findExternalLinkByTaskAndType: (...args: unknown[]) =>
      mocks.findExternalLinkByTaskAndType(...args),
  }),
);

vi.mock("../../../../../apps/api/src/plugins/gitlab/utils/gitlab-api", () => ({
  createGitlabClient: () => ({
    listSubtaskRelations: (...args: unknown[]) =>
      mocks.listSubtaskRelations(...args),
    removeSubtaskParent: (...args: unknown[]) =>
      mocks.removeSubtaskParent(...args),
  }),
}));

vi.mock(
  "../../../../../apps/api/src/plugins/gitlab/utils/create-related-issue-link",
  () => ({
    deleteRelatedIssueLink: (...args: unknown[]) =>
      mocks.deleteRelatedIssueLink(...args),
  }),
);

vi.mock(
  "../../../../../apps/api/src/plugins/gitlab/utils/sync-gitlab-task-relations",
  () => ({
    recordGitlabTaskRelation: (...args: unknown[]) =>
      mocks.recordGitlabTaskRelation(...args),
  }),
);

const { handleTaskRelationDeleted } =
  await import("../../../../../apps/api/src/plugins/gitlab/events/task-relation-deleted");

const context = {
  integrationId: "integration-1",
  projectId: "project-1",
  config: {
    baseUrl: "https://gitlab.example.com",
    accessToken: "test-token",
    projectPath: "acme/web",
  },
};

function event(
  relationType: "subtask" | "related" | "blocks",
  source: "kaneo" | "gitlab" = "kaneo",
) {
  return {
    sourceTaskId: "parent-task",
    targetTaskId: "child-task",
    relationType,
    projectId: "project-1",
    userId: "user-1",
    source,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findExternalLinkByTaskAndType.mockImplementation(
    async (taskId: string) => ({
      externalId: taskId === "parent-task" ? "5" : "10",
    }),
  );
  mocks.listSubtaskRelations.mockResolvedValue([
    { parentIid: 5, childIid: 10 },
  ]);
  mocks.removeSubtaskParent.mockResolvedValue(undefined);
  mocks.deleteRelatedIssueLink.mockResolvedValue(undefined);
  mocks.recordGitlabTaskRelation.mockResolvedValue(undefined);
});

describe("handleTaskRelationDeleted", () => {
  it("removes an actual GitLab work-item parent edge", async () => {
    await handleTaskRelationDeleted(event("subtask"), context);

    expect(mocks.removeSubtaskParent).toHaveBeenCalledWith("acme/web", 10);
    expect(mocks.deleteRelatedIssueLink).not.toHaveBeenCalled();
    expect(mocks.recordGitlabTaskRelation).toHaveBeenCalledWith(
      "integration-1",
      { sourceIid: 5, targetIid: 10, relationType: "subtask" },
      false,
    );
  });

  it("removes the related-issue fallback for an unsupported subtask parent", async () => {
    mocks.listSubtaskRelations.mockResolvedValue([]);

    await handleTaskRelationDeleted(event("subtask"), context);

    expect(mocks.deleteRelatedIssueLink).toHaveBeenCalledWith(
      context.config,
      5,
      10,
      "relates_to",
    );
  });

  it("removes ordinary related and blocking issue links", async () => {
    await handleTaskRelationDeleted(event("related"), context);
    await handleTaskRelationDeleted(event("blocks"), context);

    expect(mocks.deleteRelatedIssueLink).toHaveBeenNthCalledWith(
      1,
      context.config,
      5,
      10,
      "relates_to",
    );
    expect(mocks.deleteRelatedIssueLink).toHaveBeenNthCalledWith(
      2,
      context.config,
      5,
      10,
      "blocks",
    );
  });

  it("does not echo relation removals received from GitLab", async () => {
    await handleTaskRelationDeleted(event("subtask", "gitlab"), context);

    expect(mocks.findExternalLinkByTaskAndType).not.toHaveBeenCalled();
    expect(mocks.removeSubtaskParent).not.toHaveBeenCalled();
  });
});
