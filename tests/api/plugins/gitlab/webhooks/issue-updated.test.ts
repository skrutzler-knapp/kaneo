import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
    labelInsert: vi.fn(),
    syncGitlabLabelsToTask: vi.fn(),
    ensureGitlabWorkspaceLabels: vi.fn(),
    syncGitlabRelationsForIssues: vi.fn(),
    taskFindFirst: vi.fn(),
    db: {
      insert: () => ({
        values: (values: unknown) => {
          mocks.labelInsert(values);
          return { onConflictDoNothing: async () => undefined };
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          taskUpdates.push(values);
          return { where: async () => undefined };
        },
      }),
      query: {
        labelTable: { findMany: async () => [] },
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
    ensureGitlabWorkspaceLabels: (...args: unknown[]) =>
      mocks.ensureGitlabWorkspaceLabels(...args),
  }),
);

vi.mock(
  "../../../../../apps/api/src/plugins/gitlab/utils/sync-gitlab-task-relations",
  () => ({
    syncGitlabRelationsForIssues: (...args: unknown[]) =>
      mocks.syncGitlabRelationsForIssues(...args),
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
  mocks.syncGitlabRelationsForIssues.mockResolvedValue({
    created: 0,
    deleted: 0,
  });
  mocks.ensureGitlabWorkspaceLabels.mockResolvedValue(undefined);
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

  it("continues issue field synchronization when relation sync fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.findExternalLink.mockResolvedValue({
      id: "link-1",
      taskId: "task-1",
      metadata: JSON.stringify({ state: "open" }),
    });
    mocks.syncGitlabRelationsForIssues.mockRejectedValueOnce(
      new Error("Work item hierarchy unavailable"),
    );

    await handleGitlabIssueUpdated(titleChangedPayload("Updated in GitLab"));

    expect(mocks.taskUpdates).toContainEqual({ title: "Updated in GitLab" });
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to sync GitLab task relations:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("reconciles relations when an update changes neither text nor labels", async () => {
    mocks.findExternalLink.mockResolvedValue({
      id: "link-1",
      taskId: "task-1",
      metadata: null,
    });

    await handleGitlabIssueUpdated({
      ...titleChangedPayload("Fix the login bug"),
      changes: {},
    });

    expect(mocks.syncGitlabRelationsForIssues).toHaveBeenCalledWith(
      "project-1",
      "integration-1",
      "usekaneo/kaneo",
      [42],
    );
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
    expect(mocks.publishEvent).toHaveBeenCalledWith("task.unassigned", {
      taskId: "task-1",
      projectId: "project-1",
      userId: null,
      title: "Old title",
      type: "unassigned",
    });
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
      expect.anything(),
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
      expect.anything(),
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

    expect(mocks.labelInsert).toHaveBeenCalledWith(
      fullLabels.map((label) => ({
        name: label.title,
        color: label.color,
        taskId: "task-1",
        workspaceId: "workspace-1",
      })),
    );
    expect(mocks.ensureGitlabWorkspaceLabels).toHaveBeenCalledWith(
      "project-1",
      "workspace-1",
      fullLabels,
    );
  });
});

// Ownership locking is covered by integration-task-scope.test.ts. These cases
// exercise provider behavior with the transaction's existing database mock.
vi.mock(
  "../../../../../apps/api/src/plugins/github/services/integration-task-scope",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../../apps/api/src/plugins/github/services/integration-task-scope")
      >();
    return {
      ...actual,
      withIntegrationTask: async (
        _taskId: string,
        _integration: unknown,
        apply: (
          database: unknown,
          afterCommit: (effect: () => Promise<void>) => void,
        ) => Promise<unknown>,
      ) => {
        const database = (await import("../../../../../apps/api/src/database"))
          .default;
        const effects: Array<() => Promise<void>> = [];
        const result = await apply(database, (effect) => effects.push(effect));
        for (const effect of effects) await effect();
        return result;
      },
    };
  },
);

vi.mock(
  "../../../../../apps/api/src/plugins/github/services/with-integration-link",
  async () => ({
    withIntegrationLink: async (
      link: unknown,
      integration: unknown,
      apply: (
        database: unknown,
        afterCommit: (effect: () => Promise<void>) => void,
        link: unknown,
      ) => Promise<unknown>,
    ) => {
      const { withIntegrationTask } =
        await import("../../../../../apps/api/src/plugins/github/services/integration-task-scope");
      return withIntegrationTask(
        (link as { taskId: string }).taskId,
        integration as Parameters<typeof withIntegrationTask>[1],
        (database, afterCommit) => apply(database, afterCommit, link),
      );
    },
  }),
);
