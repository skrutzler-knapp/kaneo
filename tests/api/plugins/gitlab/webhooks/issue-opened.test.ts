import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { handleGitlabIssueOpened } from "../../../../../apps/api/src/plugins/gitlab/webhooks/issue-opened";

const mocks = vi.hoisted(() => {
  const insertedValues: Array<Record<string, unknown>> = [];

  return {
    insertedValues,
    findAllIntegrationsByGitlabProject: vi.fn(),
    findExternalLink: vi.fn(),
    createExternalLink: vi.fn(),
    claimTaskNumber: vi.fn(),
    resolveTargetStatus: vi.fn(),
    publishEvent: vi.fn(),
    lockedIntegration: vi.fn(),
    columnFindFirst: vi.fn(),
    projectFindFirst: vi.fn(),
    createGitlabClient: vi.fn(),
    addLabelsToIssueGitlab: vi.fn(),
    syncGitlabLabelsToTask: vi.fn(),
    ensureGitlabWorkspaceLabels: vi.fn(),
    syncGitlabRelationsForIssues: vi.fn(),
    db: {
      transaction: async (run: (tx: unknown) => Promise<unknown>) =>
        run(mocks.db),
      select: () => ({
        from: () => ({ where: () => ({ for: mocks.lockedIntegration }) }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          insertedValues.push(values);
          return { returning: async () => [{ id: "task-1", number: 7 }] };
        },
      }),
      query: {
        columnTable: {
          findFirst: (...args: unknown[]) => mocks.columnFindFirst(...args),
        },
        projectTable: {
          findFirst: (...args: unknown[]) => mocks.projectFindFirst(...args),
        },
      },
    },
  };
});

vi.mock("../../../../../apps/api/src/plugins/sync/eligibility", () => ({
  canSyncTask: async () => true,
}));

vi.mock("../../../../../apps/api/src/database", () => ({ default: mocks.db }));

vi.mock("../../../../../apps/api/src/events", () => ({
  publishEvent: (...args: unknown[]) => mocks.publishEvent(...args),
}));

vi.mock(
  "../../../../../apps/api/src/task/controllers/claim-task-numbers",
  () => ({
    claimTaskNumber: (...args: unknown[]) => mocks.claimTaskNumber(...args),
  }),
);

vi.mock(
  "../../../../../apps/api/src/plugins/github/services/link-manager",
  () => ({
    createExternalLink: (...args: unknown[]) =>
      mocks.createExternalLink(...args),
    findExternalLink: (...args: unknown[]) => mocks.findExternalLink(...args),
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
  "../../../../../apps/api/src/plugins/gitlab/utils/resolve-column",
  () => ({
    resolveTargetStatus: (...args: unknown[]) =>
      mocks.resolveTargetStatus(...args),
  }),
);

vi.mock("../../../../../apps/api/src/plugins/gitlab/utils/gitlab-api", () => ({
  createGitlabClient: (...args: unknown[]) => mocks.createGitlabClient(...args),
}));

vi.mock("../../../../../apps/api/src/plugins/gitlab/utils/labels", () => ({
  addLabelsToIssueGitlab: (...args: unknown[]) =>
    mocks.addLabelsToIssueGitlab(...args),
}));

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
  project: { workspaceId: "workspace-1" },
  isActive: true,
  type: "gitlab",
  config: JSON.stringify({
    baseUrl: "https://gitlab.com",
    projectPath: "usekaneo/kaneo",
    accessToken: "token",
    commentTaskLinkOnGitlabIssue: false,
  }),
};

function issueOpenedPayload(labels: Array<{ title: string }>) {
  return {
    user: { username: "octocat" },
    object_attributes: {
      iid: 42,
      title: "Fix the login bug",
      description: "Steps to reproduce",
      url: "https://gitlab.com/usekaneo/kaneo/-/issues/42",
      action: "open",
    },
    labels,
    project: {
      name: "kaneo",
      web_url: "https://gitlab.com/usekaneo/kaneo",
      path_with_namespace: "usekaneo/kaneo",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lockedIntegration.mockResolvedValue([integration]);
  mocks.insertedValues.length = 0;
  mocks.findAllIntegrationsByGitlabProject.mockResolvedValue([integration]);
  mocks.findExternalLink.mockResolvedValue(null);
  mocks.claimTaskNumber.mockResolvedValue(7);
  mocks.resolveTargetStatus.mockResolvedValue("to-do");
  mocks.columnFindFirst.mockResolvedValue(null);
  mocks.projectFindFirst.mockResolvedValue({
    id: "project-1",
    workspaceId: "workspace-1",
    slug: "KAN",
  });
  mocks.createExternalLink.mockResolvedValue({ id: "link-1" });
  mocks.publishEvent.mockResolvedValue(undefined);
  mocks.syncGitlabRelationsForIssues.mockResolvedValue({
    created: 0,
    deleted: 0,
  });
  mocks.ensureGitlabWorkspaceLabels.mockResolvedValue(undefined);
});

describe("handleGitlabIssueOpened", () => {
  it("persists a valid default priority when the issue has no priority: label", async () => {
    await handleGitlabIssueOpened(issueOpenedPayload([{ title: "type:bug" }]));

    expect(mocks.insertedValues).toHaveLength(1);
    expect(mocks.insertedValues[0].priority).toBe("low");
  });

  it("reads the priority label out of the webhook's label titles", async () => {
    await handleGitlabIssueOpened(
      issueOpenedPayload([{ title: "type:bug" }, { title: "priority:high" }]),
    );

    expect(mocks.insertedValues).toHaveLength(1);
    expect(mocks.insertedValues[0].priority).toBe("high");
  });

  it("records the issue link before publishing task.created", async () => {
    await handleGitlabIssueOpened(issueOpenedPayload([]));

    const linkOrder = mocks.createExternalLink.mock.invocationCallOrder[0];
    const eventOrder = mocks.publishEvent.mock.invocationCallOrder[0];
    expect(linkOrder).toBeLessThan(eventOrder);
    expect(mocks.createExternalLink).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "issue",
        externalId: "42",
        url: "https://gitlab.com/usekaneo/kaneo/-/issues/42",
      }),
      mocks.db,
    );
  });

  it("stores the GitLab assignee externally without assigning a Kaneo user", async () => {
    const gitlabOwnedIntegration = {
      ...integration,
      config: JSON.stringify({
        baseUrl: "https://gitlab.com",
        projectPath: "usekaneo/kaneo",
        accessToken: "token",
        commentTaskLinkOnGitlabIssue: false,
        gitlabOwnsAssignees: true,
      }),
    };
    mocks.findAllIntegrationsByGitlabProject.mockResolvedValue([
      gitlabOwnedIntegration,
    ]);
    mocks.lockedIntegration.mockResolvedValue([gitlabOwnedIntegration]);
    const payload = {
      ...issueOpenedPayload([]),
      assignees: [
        {
          id: 42,
          username: "ada",
          name: "Ada Lovelace",
          avatar_url: "https://gitlab.com/ada.png",
        },
      ],
    };

    await handleGitlabIssueOpened(payload);

    expect(mocks.insertedValues[0]?.userId).toBeNull();
    expect(mocks.createExternalLink).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          gitlabAssignees: [
            {
              id: "42",
              username: "ada",
              name: "Ada Lovelace",
              avatarUrl: "https://gitlab.com/ada.png",
            },
          ],
        }),
      }),
      mocks.db,
    );
  });

  it("ensures workspace labels from the issue payload", async () => {
    mocks.projectFindFirst.mockResolvedValue({
      id: "project-1",
      workspaceId: "workspace-1",
      slug: "KAN",
    });
    const payload = issueOpenedPayload([
      { title: "backend", color: "#123456" },
      { title: "customer-visible", color: "#abcdef" },
      { title: "priority:high", color: "#ff0000" },
    ]);

    await handleGitlabIssueOpened(payload);

    expect(mocks.syncGitlabLabelsToTask).toHaveBeenCalledWith(
      "task-1",
      "project-1",
      "workspace-1",
      payload.labels,
    );
    expect(mocks.ensureGitlabWorkspaceLabels).toHaveBeenCalledWith(
      "project-1",
      "workspace-1",
      payload.labels,
    );
  });

  it("publishes task.created before best-effort relation synchronization", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.syncGitlabRelationsForIssues.mockRejectedValueOnce(
      new Error("Work item hierarchy unavailable"),
    );

    await handleGitlabIssueOpened(issueOpenedPayload([]));

    expect(mocks.publishEvent).toHaveBeenCalledWith(
      "task.created",
      expect.objectContaining({ taskId: "task-1" }),
    );
    expect(
      mocks.syncGitlabRelationsForIssues.mock.invocationCallOrder[0],
    ).toBeGreaterThan(mocks.publishEvent.mock.invocationCallOrder[0]);
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to sync GitLab task relations:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("continues past relation failures for an existing issue link", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.findExternalLink.mockResolvedValue({
      id: "link-1",
      taskId: "task-1",
    });
    mocks.syncGitlabRelationsForIssues.mockRejectedValueOnce(
      new Error("Work item hierarchy unavailable"),
    );

    await expect(
      handleGitlabIssueOpened(issueOpenedPayload([])),
    ).resolves.toBeUndefined();

    expect(mocks.insertedValues).toHaveLength(0);
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to sync GitLab task relations:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("keeps a confidential issue out of the workspace", async () => {
    const payload = issueOpenedPayload([]);
    await handleGitlabIssueOpened({
      ...payload,
      object_attributes: { ...payload.object_attributes, confidential: true },
    });

    expect(mocks.insertedValues).toHaveLength(0);
    expect(mocks.findAllIntegrationsByGitlabProject).not.toHaveBeenCalled();
  });

  it("skips an issue that already has a task", async () => {
    mocks.findExternalLink.mockResolvedValue({
      id: "link-1",
      taskId: "task-1",
    });

    await handleGitlabIssueOpened(issueOpenedPayload([]));

    expect(mocks.insertedValues).toHaveLength(0);
    expect(mocks.claimTaskNumber).not.toHaveBeenCalled();
  });
});

vi.mock("../../../../../apps/api/src/plugins/sync/issue-labels", () => ({
  importIssueLabels: async () => undefined,
}));
