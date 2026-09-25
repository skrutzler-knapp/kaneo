import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, TaskCreatedEvent } from "../../../../../apps/api/src/plugins/types";

vi.mock("../../../../../apps/api/src/plugins/sync/create-task-issue", () => ({
  withTaskSyncCreation: (event: TaskCreatedEvent, _context: PluginContext, apply: (event: TaskCreatedEvent) => Promise<void>) => apply(event),
}));
vi.mock("../../../../../apps/api/src/plugins/sync/eligibility", () => ({ canSyncTask: async () => true }));
vi.mock("../../../../../apps/api/src/plugins/sync/initialize-task-issue", () => ({
  isIssueInitializationPending: () => false,
  initializeTaskIssue: async (_event: unknown, _context: unknown, _link: unknown, writes: { labels: () => Promise<unknown> }) => { await writes.labels(); },
}));
vi.mock("../../../../../apps/api/src/plugins/sync/sync-task-field-labels", () => ({ syncTaskFieldLabels: async () => undefined }));

const mocks = vi.hoisted(() => ({
  addLabelsToIssueGitlab: vi.fn(),
  createExternalLink: vi.fn(),
  createIssue: vi.fn(),
  findExternalLinkByTaskAndType: vi.fn(),
  findSubtaskRelationsByTask: vi.fn(),
  syncTaskLabelsToGitlab: vi.fn(),
  formatIssueBody: vi.fn(),
  formatIssueTitle: vi.fn(),
  getLabelsForIssue: vi.fn(),
  createRelatedIssueLink: vi.fn(),
  isUnsupportedGitlabHierarchyParent: vi.fn(),
  setSubtaskParent: vi.fn(),
}));

vi.mock("../../../../../apps/api/src/plugins/github/services/link-manager", () => ({
  createExternalLink: (...args: unknown[]) => mocks.createExternalLink(...args),
  findExternalLinkByTaskAndType: (...args: unknown[]) =>
    mocks.findExternalLinkByTaskAndType(...args),
  findSubtaskRelationsByTask: (...args: unknown[]) =>
    mocks.findSubtaskRelationsByTask(...args),
}));

vi.mock("../../../../../apps/api/src/plugins/github/utils/format", () => ({
  formatIssueBody: (...args: unknown[]) => mocks.formatIssueBody(...args),
  formatIssueTitle: (...args: unknown[]) => mocks.formatIssueTitle(...args),
  getLabelsForIssue: (...args: unknown[]) => mocks.getLabelsForIssue(...args),
}));

vi.mock("../../../../../apps/api/src/plugins/gitlab/utils/gitlab-api", () => ({
  createGitlabClient: () => ({
    createIssue: (...args: unknown[]) => mocks.createIssue(...args),
  }),
}));

vi.mock("../../../../../apps/api/src/plugins/gitlab/utils/set-subtask-parent", () => ({
  setGitlabSubtaskParent: (...args: unknown[]) => mocks.setSubtaskParent(...args),
}));

vi.mock("../../../../../apps/api/src/plugins/gitlab/utils/sync-task-labels-to-gitlab", () => ({
  syncTaskLabelsToGitlab: (...args: unknown[]) =>
    mocks.syncTaskLabelsToGitlab(...args),
}));

vi.mock("../../../../../apps/api/src/plugins/gitlab/utils/labels", () => ({
  addLabelsToIssueGitlab: (...args: unknown[]) =>
    mocks.addLabelsToIssueGitlab(...args),
}));

vi.mock(
  "../../../../../apps/api/src/plugins/gitlab/utils/create-related-issue-link",
  () => ({
    createRelatedIssueLink: (...args: unknown[]) =>
      mocks.createRelatedIssueLink(...args),
    isUnsupportedGitlabHierarchyParent: (...args: unknown[]) =>
      mocks.isUnsupportedGitlabHierarchyParent(...args),
  }),
);

const { handleTaskCreated } = await import(
  "../../../../../apps/api/src/plugins/gitlab/events/task-created"
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

const event = {
  taskId: "child-task",
  projectId: "project-1",
  userId: "user-1",
  title: "Child task",
  description: "",
  priority: "no-priority",
  status: "to-do",
  number: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
  let initialChildLinkLookup = true;
  mocks.findExternalLinkByTaskAndType.mockImplementation(
    async (taskId: string) => {
      if (taskId === "child-task" && initialChildLinkLookup) {
        initialChildLinkLookup = false;
        return null;
      }
      return { externalId: taskId === "parent-task" ? "1" : "4" };
    },
  );
  mocks.findSubtaskRelationsByTask.mockResolvedValue([
    { sourceTaskId: "parent-task", targetTaskId: "child-task" },
  ]);
  mocks.createIssue.mockResolvedValue({
    iid: 4,
    web_url: "https://gitlab.example.com/acme/web/-/work_items/4",
    title: "Child task",
    state: "opened",
  });
  mocks.createExternalLink.mockResolvedValue({ id: "external-link-1" });
  mocks.addLabelsToIssueGitlab.mockResolvedValue(undefined);
  mocks.setSubtaskParent.mockResolvedValue(undefined);
  mocks.isUnsupportedGitlabHierarchyParent.mockReturnValue(false);
});

describe("handleTaskCreated", () => {
  it("reconciles saved subtasks after creating the GitLab issue link", async () => {
    await handleTaskCreated(event, context);

    expect(mocks.createExternalLink).toHaveBeenCalled();
    expect(mocks.createIssue).toHaveBeenCalledWith(
      "acme/web",
      expect.objectContaining({ issue_type: "task" }),
    );
    expect(mocks.findSubtaskRelationsByTask).toHaveBeenCalledWith("child-task");
    expect(mocks.setSubtaskParent).toHaveBeenCalledWith(context.config, 1, 4);
  });

  it("reconciles saved subtasks when the GitLab issue link already exists", async () => {
    mocks.findExternalLinkByTaskAndType.mockImplementation(
      async (taskId: string) => ({
        externalId: taskId === "parent-task" ? "1" : "4",
      }),
    );

    await handleTaskCreated(event, context);

    expect(mocks.findSubtaskRelationsByTask).toHaveBeenCalledWith("child-task");
    expect(mocks.createIssue).not.toHaveBeenCalled();
    expect(mocks.setSubtaskParent).toHaveBeenCalledWith(context.config, 1, 4);
  });

  it("keeps top-level Kaneo tasks as GitLab issues", async () => {
    mocks.findSubtaskRelationsByTask.mockResolvedValue([]);

    await handleTaskCreated(event, context);

    expect(mocks.createIssue).toHaveBeenCalledWith(
      "acme/web",
      expect.not.objectContaining({ issue_type: "task" }),
    );
  });

  it("creates a related-issue link when GitLab rejects the hierarchy type", async () => {
    mocks.setSubtaskParent.mockRejectedValue(
      new Error("GitLab cannot add this child item type"),
    );
    mocks.isUnsupportedGitlabHierarchyParent.mockReturnValue(true);

    await handleTaskCreated(event, context);

    expect(mocks.createRelatedIssueLink).toHaveBeenCalledWith(
      context.config,
      1,
      4,
    );
  });
});