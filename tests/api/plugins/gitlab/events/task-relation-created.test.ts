import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findExternalLinkByTaskAndType: vi.fn(),
  setSubtaskParent: vi.fn(),
}));

vi.mock(
  "../../../../../apps/api/src/plugins/github/services/link-manager",
  () => ({
    findExternalLinkByTaskAndType: (...args: unknown[]) =>
      mocks.findExternalLinkByTaskAndType(...args),
  }),
);

vi.mock("../../../../../apps/api/src/plugins/gitlab/utils/set-subtask-parent", () => ({
  setGitlabSubtaskParent: (...args: unknown[]) => mocks.setSubtaskParent(...args),
}));

vi.mock(
  "../../../../../apps/api/src/plugins/gitlab/utils/create-related-issue-link",
  () => ({
    createRelatedIssueLink: vi.fn(),
    isUnsupportedGitlabHierarchyParent: () => false,
  }),
);

const { handleTaskRelationCreated } = await import(
  "../../../../../apps/api/src/plugins/gitlab/events/task-relation-created-idempotent"
);

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
  mocks.findExternalLinkByTaskAndType.mockImplementation(
    async (taskId: string) => ({
      externalId: taskId === "parent-task" ? "1" : "4",
    }),
  );
  mocks.setSubtaskParent.mockResolvedValue(undefined);
});

describe("handleTaskRelationCreated", () => {
  it("sets the GitLab child parent when Kaneo creates a subtask relation", async () => {
    await handleTaskRelationCreated(
      {
        sourceTaskId: "parent-task",
        targetTaskId: "child-task",
        relationType: "subtask",
        projectId: "project-1",
        source: "kaneo",
      },
      context,
    );

    expect(mocks.setSubtaskParent).toHaveBeenCalledWith(context.config, 1, 4);
  });

  it("does not echo relations imported from GitLab back to GitLab", async () => {
    await handleTaskRelationCreated(
      {
        sourceTaskId: "parent-task",
        targetTaskId: "child-task",
        relationType: "subtask",
        projectId: "project-1",
        source: "gitlab",
      },
      context,
    );

    expect(mocks.findExternalLinkByTaskAndType).not.toHaveBeenCalled();
    expect(mocks.setSubtaskParent).not.toHaveBeenCalled();
  });
});
