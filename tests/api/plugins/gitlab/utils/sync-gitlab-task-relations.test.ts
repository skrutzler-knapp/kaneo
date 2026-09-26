import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const links = [
    {
      id: "link-5",
      integrationId: "integration-1",
      resourceType: "issue",
      externalId: "5",
      taskId: "task-5",
      metadata: JSON.stringify({ state: "opened" }),
    },
    {
      id: "link-3",
      integrationId: "integration-1",
      resourceType: "issue",
      externalId: "3",
      taskId: "task-3",
      metadata: JSON.stringify({ state: "opened" }),
    },
    {
      id: "link-10",
      integrationId: "integration-1",
      resourceType: "issue",
      externalId: "10",
      taskId: "task-10",
      metadata: JSON.stringify({ state: "opened" }),
    },
  ];
  const taskRelations: Array<{
    id: string;
    sourceTaskId: string;
    targetTaskId: string;
    relationType: string;
  }> = [];
  const client = {
    getProject: vi.fn().mockResolvedValue({ id: 42 }),
    listSubtaskRelations: vi
      .fn()
      .mockResolvedValue([{ parentIid: 5, childIid: 10 }]),
    listIssueLinks: vi
      .fn()
      .mockResolvedValue([
        { issue_link_id: 19, iid: 3, project_id: 42, link_type: "relates_to" },
      ]),
  };
  let transactionIndex = 0;

  const db = {
    query: {
      integrationTable: {
        findFirst: vi.fn().mockResolvedValue({
          config: JSON.stringify({
            baseUrl: "https://gitlab.example.com",
            accessToken: "test-token",
            projectPath: "acme/web",
          }),
        }),
      },
      taskRelationTable: {
        findMany: vi.fn(async () => [...taskRelations]),
      },
    },
    insert: vi.fn(() => ({
      values: (values: Omit<(typeof taskRelations)[number], "id">) => ({
        returning: async () => {
          const relation = { ...values, id: `relation-${taskRelations.length + 1}` };
          taskRelations.push(relation);
          return [relation];
        },
      }),
    })),
    delete: vi.fn(() => ({
      where: () => ({
        returning: async () => {
          const [removed] = taskRelations.splice(0, 1);
          return removed ? [removed] : [];
        },
      }),
    })),
    transaction: vi.fn(async (callback: (transaction: unknown) => unknown) => {
      const link = links[transactionIndex++ % links.length];
      const transaction = {
        select: () => ({
          from: () => ({
            where: () => ({
              for: async () => [{ metadata: link.metadata }],
            }),
          }),
        }),
        update: () => ({
          set: (values: { metadata: string }) => ({
            where: async () => {
              link.metadata = values.metadata;
            },
          }),
        }),
      };
      return callback(transaction);
    }),
  };

  return {
    links,
    taskRelations,
    client,
    db,
    resetTransactionIndex: () => {
      transactionIndex = 0;
    },
    getExternalLinksByIntegration: vi.fn(async () => {
      transactionIndex = 0;
      return links;
    }),
    publishEvent: vi.fn(),
    createGitlabClient: vi.fn(() => client),
  };
});

vi.mock("../../../../../apps/api/src/database", () => ({ default: mocks.db }));
vi.mock("../../../../../apps/api/src/events", () => ({
  publishEvent: (...args: unknown[]) => mocks.publishEvent(...args),
}));
vi.mock("../../../../../apps/api/src/plugins/github/services/link-manager", () => ({
  getExternalLinksByIntegration: (...args: unknown[]) =>
    mocks.getExternalLinksByIntegration(...args),
}));
vi.mock("../../../../../apps/api/src/plugins/gitlab/utils/gitlab-api", () => ({
  createGitlabClient: (...args: unknown[]) => mocks.createGitlabClient(...args),
}));

const { syncGitlabRelationsForIssues } = await import(
  "../../../../../apps/api/src/plugins/gitlab/utils/sync-gitlab-task-relations"
);

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.taskRelations.length = 0;
  for (const link of mocks.links) {
    link.metadata = JSON.stringify({ state: "opened" });
  }
  mocks.client.listSubtaskRelations.mockResolvedValue([
    { parentIid: 5, childIid: 10 },
  ]);
  mocks.client.listIssueLinks.mockResolvedValue([
    { issue_link_id: 19, iid: 3, project_id: 42, link_type: "relates_to" },
  ]);
  mocks.resetTransactionIndex();
});

describe("syncGitlabRelationsForIssues", () => {
  it("imports hierarchy and linked issues, then removes them when GitLab unlinks them", async () => {
    await expect(
      syncGitlabRelationsForIssues(
        "project-1",
        "integration-1",
        "acme/web",
        [5],
      ),
    ).resolves.toEqual({ created: 2, deleted: 0 });

    expect(mocks.taskRelations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTaskId: "task-5",
          targetTaskId: "task-10",
          relationType: "subtask",
        }),
        expect.objectContaining({
          sourceTaskId: "task-3",
          targetTaskId: "task-5",
          relationType: "related",
        }),
      ]),
    );
    expect(JSON.parse(mocks.links[2].metadata)).toMatchObject({
      state: "opened",
      gitlabTaskRelations: [
        { sourceIid: 5, targetIid: 10, relationType: "subtask" },
      ],
    });

    mocks.client.listSubtaskRelations.mockResolvedValue([]);
    mocks.client.listIssueLinks.mockResolvedValue([]);
    mocks.resetTransactionIndex();

    await expect(
      syncGitlabRelationsForIssues(
        "project-1",
        "integration-1",
        "acme/web",
        [5],
      ),
    ).resolves.toEqual({ created: 0, deleted: 2 });

    expect(mocks.taskRelations).toHaveLength(0);
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      "task-relation.deleted",
      expect.objectContaining({ source: "gitlab" }),
    );
    expect(JSON.parse(mocks.links[2].metadata)).toMatchObject({
      state: "opened",
      gitlabTaskRelations: [],
    });
  });
});