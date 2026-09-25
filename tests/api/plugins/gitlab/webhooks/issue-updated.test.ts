import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGitlabIssueUpdated } from "../../../../../apps/api/src/plugins/gitlab/webhooks/issue-updated";

const mocks = vi.hoisted(() => {
  const taskUpdates: Array<Record<string, unknown>> = [];

  return {
    taskUpdates,
    findAllIntegrationsByGitlabProject: vi.fn(),
    findExternalLink: vi.fn(),
    updateExternalLink: vi.fn(),
    updateTaskStatus: vi.fn(),
    publishEvent: vi.fn(),
    syncGitlabLabelsToTask: vi.fn(),
    syncGitlabLabelCatalog: vi.fn(),
    taskFindFirst: vi.fn(),
    db: {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          taskUpdates.push(values);
          return { where: async () => undefined };
        },
      }),
      query: {
        taskTable: {
          findFirst: (...args: unknown[]) => mocks.taskFindFirst(...args),
        },
      },
    },
  };
});

vi.mock("../../../../../apps/api/src/database", () => ({ default: mocks.db }));

vi.mock("../../../../../apps/api/src/events", () => ({
  publishEvent: (...args: unknown[]) => mocks.publishEvent(...args),
}));

vi.mock(
  "../../../../../apps/api/src/plugins/github/services/link-manager",
  () => ({
    findExternalLink: (...args: unknown[]) => mocks.findExternalLink(...args),
    updateExternalLink: (...args: unknown[]) =>
      mocks.updateExternalLink(...args),
  }),
);

vi.mock(
  "../../../../../apps/api/src/plugins/github/services/task-service",
  () => ({
    updateTaskStatus: (...args: unknown[]) => mocks.updateTaskStatus(...args),
  }),
);

vi.mock(
  "../../../../../apps/api/src/plugins/gitlab/services/integration-lookup",
  () => ({
    findAllIntegrationsByGitlabProject: (...args: unknown[]) =>
      mocks.findAllIntegrationsByGitlabProject(...args),
  }),
);

vi.mock(
  "../../../../../apps/api/src/plugins/gitlab/utils/sync-gitlab-labels-to-task",
  () => ({
    syncGitlabLabelsToTask: (...args: unknown[]) =>
      mocks.syncGitlabLabelsToTask(...args),
  }),
);

vi.mock(
  "../../../../../apps/api/src/plugins/gitlab/utils/sync-gitlab-label-catalog",
  () => ({
    syncGitlabLabelCatalog: (...args: unknown[]) =>
      mocks.syncGitlabLabelCatalog(...args),
  }),
);

const integration = {
  id: "integration-1",
  projectId: "project-1",
  isActive: true,
  type: "gitlab",
  config: JSON.stringify({
    baseUrl: "https://gitlab.com",
    projectPath: "usekaneo/kaneo",
    accessToken: "token",
  }),
};

function titleChangedPayload(title: string) {
  return {
    object_attributes: {
      iid: 42,
      title,
      description: "Steps to reproduce",
      url: "https://gitlab.com/usekaneo/kaneo/-/issues/42",
      action: "update",
    },
    changes: {
      title: { previous: "Old title", current: title },
    },
    project: {
      name: "kaneo",
      web_url: "https://gitlab.com/usekaneo/kaneo",
      path_with_namespace: "usekaneo/kaneo",
    },
  };
}

function linkWithLastTitleWrittenByKaneo(title: string) {
  return {
    id: "link-1",
    taskId: "task-1",
    metadata: JSON.stringify({
      state: "open",
      lastSync: {
        title: {
          // Just now, so a window-based guard would swallow both cases below.
          timestamp: new Date().toISOString(),
          source: "kaneo",
          value: title,
        },
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.taskUpdates.length = 0;
  mocks.findAllIntegrationsByGitlabProject.mockResolvedValue([integration]);
  mocks.taskFindFirst.mockResolvedValue({
    id: "task-1",
    projectId: "project-1",
    project: { workspaceId: "workspace-1" },
    userId: null,
  });
  mocks.updateExternalLink.mockResolvedValue(undefined);
});

describe("handleGitlabIssueUpdated", () => {
  it("applies a title edit that arrives from GitLab", async () => {
    mocks.findExternalLink.mockResolvedValue({
      id: "link-1",
      taskId: "task-1",
      metadata: JSON.stringify({ state: "open" }),
    });

    await handleGitlabIssueUpdated(titleChangedPayload("Fix the login bug"));

    expect(mocks.taskUpdates).toEqual([{ title: "Fix the login bug" }]);
  });

  it("ignores the echo of a title Kaneo just wrote", async () => {
    mocks.findExternalLink.mockResolvedValue(
      linkWithLastTitleWrittenByKaneo("Written by Kaneo"),
    );

    await handleGitlabIssueUpdated(titleChangedPayload("Written by Kaneo"));

    expect(mocks.taskUpdates).toHaveLength(0);
    expect(mocks.updateExternalLink).not.toHaveBeenCalled();
  });

  it("keeps a different title edited right after Kaneo's own write", async () => {
    mocks.findExternalLink.mockResolvedValue(
      linkWithLastTitleWrittenByKaneo("Written by Kaneo"),
    );

    await handleGitlabIssueUpdated(titleChangedPayload("Edited in GitLab"));

    expect(mocks.taskUpdates).toEqual([{ title: "Edited in GitLab" }]);
  });

  it("does nothing when the update changed neither text nor labels", async () => {
    mocks.findExternalLink.mockResolvedValue({
      id: "link-1",
      taskId: "task-1",
      metadata: null,
    });

    await handleGitlabIssueUpdated({
      ...titleChangedPayload("Fix the login bug"),
      changes: {},
    });

    expect(mocks.findExternalLink).not.toHaveBeenCalled();
    expect(mocks.taskUpdates).toHaveLength(0);
  });

  it("stores GitLab assignee data without writing a Kaneo user assignment", async () => {
    mocks.findExternalLink.mockResolvedValue({
      id: "link-1",
      taskId: "task-1",
      metadata: null,
    });
    mocks.taskFindFirst.mockResolvedValue({
      id: "task-1",
      projectId: "project-1",
      title: "Old title",
      userId: "existing-kaneo-user",
      project: { workspaceId: "workspace-1" },
    });
    const gitlabOwnedIntegration = {
      ...integration,
      config: JSON.stringify({
        baseUrl: "https://gitlab.com",
        projectPath: "usekaneo/kaneo",
        accessToken: "token",
        gitlabOwnsAssignees: true,
      }),
    };
    mocks.findAllIntegrationsByGitlabProject.mockResolvedValue([
      gitlabOwnedIntegration,
    ]);
    const assignees = [
      {
        id: 42,
        username: "ada",
        name: "Ada Lovelace",
        avatar_url: "https://gitlab.com/ada.png",
      },
    ];

    await handleGitlabIssueUpdated({
      ...titleChangedPayload("Unchanged title"),
      changes: { assignees: { previous: [], current: assignees } },
    });

    expect(mocks.taskUpdates).toEqual([{ userId: null }]);
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      "task.updated",
      expect.objectContaining({
        taskId: "task-1",
      }),
    );
    expect(mocks.updateExternalLink).toHaveBeenCalledWith(
      "link-1",
      expect.objectContaining({
        metadata: {
          gitlabAssignees: [
            {
              id: "42",
              username: "ada",
              name: "Ada Lovelace",
              avatarUrl: "https://gitlab.com/ada.png",
            },
          ],
        },
      }),
    );
  });

  it("does not import GitLab assignment details unless GitLab owns assignees", async () => {
    mocks.findExternalLink.mockResolvedValue({
      id: "link-1",
      taskId: "task-1",
      metadata: null,
    });

    await handleGitlabIssueUpdated({
      ...titleChangedPayload("Unchanged title"),
      changes: {
        assignees: {
          previous: [],
          current: [{ id: 42, username: "ada", name: "Ada Lovelace" }],
        },
      },
    });

    expect(mocks.updateExternalLink).not.toHaveBeenCalled();
    expect(mocks.taskUpdates).toHaveLength(0);
  });

  it("stores multiple GitLab assignees without assigning a Kaneo user", async () => {
    mocks.findExternalLink.mockResolvedValue({
      id: "link-1",
      taskId: "task-1",
      metadata: null,
    });
    mocks.findAllIntegrationsByGitlabProject.mockResolvedValue([
      {
        ...integration,
        config: JSON.stringify({
          baseUrl: "https://gitlab.com",
          projectPath: "usekaneo/kaneo",
          accessToken: "token",
          gitlabOwnsAssignees: true,
        }),
      },
    ]);
    mocks.taskFindFirst.mockResolvedValue({
      id: "task-1",
      projectId: "project-1",
      title: "Old title",
      userId: null,
      project: { workspaceId: "workspace-1" },
    });
    const assignees = [
      { id: 42, username: "ada", name: "Ada Lovelace" },
      { id: 43, username: "grace", name: "Grace Hopper" },
    ];

    await handleGitlabIssueUpdated({
      ...titleChangedPayload("Unchanged title"),
      changes: { assignees: { current: assignees } },
    });

    expect(mocks.taskUpdates).toHaveLength(0);
    expect(mocks.updateExternalLink).toHaveBeenCalledWith(
      "link-1",
      expect.objectContaining({
        metadata: {
          gitlabAssignees: [
            {
              id: "42",
              username: "ada",
              name: "Ada Lovelace",
              avatarUrl: null,
            },
            {
              id: "43",
              username: "grace",
              name: "Grace Hopper",
              avatarUrl: null,
            },
          ],
        },
      }),
    );
  });

  it("uses the complete current GitLab label list rather than the webhook delta", async () => {
    mocks.findExternalLink.mockResolvedValue({
      id: "link-1",
      taskId: "task-1",
      metadata: null,
    });
    const fullLabels = [
      { title: "backend", color: "#123456" },
      { title: "customer-visible", color: "#abcdef" },
    ];

    await handleGitlabIssueUpdated({
      ...titleChangedPayload("Old title"),
      labels: fullLabels,
      changes: {
        labels: {
          previous: [{ title: "backend", color: "#123456" }],
          current: [{ title: "customer-visible", color: "#abcdef" }],
        },
      },
    });

    expect(mocks.syncGitlabLabelsToTask).toHaveBeenCalledWith(
      "task-1",
      "project-1",
      "workspace-1",
      fullLabels,
      ["backend"],
    );
    expect(mocks.syncGitlabLabelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "usekaneo/kaneo" }),
      "project-1",
      "workspace-1",
    );
  });
});
