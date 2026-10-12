import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { syncGitlabAssigneesForImportedIssues } from "../../apps/api/src/gitlab-integration/controllers/sync-gitlab-assignees";
import { reconcileGitlabUserAssignments } from "../../apps/api/src/gitlab-integration/controllers/reconcile-gitlab-user-assignments";
import { createGitlabAssigneeResolver } from "../../apps/api/src/plugins/gitlab/utils/resolve-assignee";
import getAssignedTasks from "../../apps/api/src/task/controllers/get-assigned-tasks";
import getTask from "../../apps/api/src/task/controllers/get-task";
import duplicateTask from "../../apps/api/src/task/controllers/duplicate-task";
import "../../apps/api/src/notification";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), listIssues: vi.fn() }));
vi.mock("../../apps/api/src/plugins/gitlab/utils/gitlab-api", () => ({
  createGitlabClient: () => mocks,
}));
vi.mock("../../apps/api/src/events", async (original) => {
  const actual = await original<typeof import("../../apps/api/src/events")>();
  return {
    ...actual,
    publishEvent: (type: string, data: unknown) =>
      actual.publishEvent(type, data, { waitForHandlers: true }),
  };
});
vi.mock(
  "../../apps/api/src/notification-preferences/delivery",
  async (original) => ({
    ...(await original<object>()),
    deliverNotification: async () => undefined,
  }),
);

const config = {
  baseUrl: "https://git.example.com",
  projectPath: "team/project",
  accessToken: "test-token",
  gitlabOwnsAssignees: true,
};
const assignees = [{ id: "42", username: "ada", name: "Ada", avatarUrl: null }];

beforeEach(async () => {
  await resetTestDatabase();
  vi.clearAllMocks();
  vi.stubEnv(
    "CUSTOM_OAUTH_USER_INFO_URL",
    "https://git.example.com/oauth/userinfo",
  );
  vi.stubEnv("CUSTOM_OAUTH_DISCOVERY_URL", "");
  mocks.getUser.mockResolvedValue({ id: 42, public_email: null });
});

async function context(sso = true) {
  const member = await createWorkspaceMember();
  const { project, columns } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  if (sso)
    await db.insert(schema.accountTable).values({
      accountId: "42",
      providerId: "custom",
      userId: member.user.id,
    });
  return {
    ...member,
    project,
    columns,
    resolve: createGitlabAssigneeResolver(config, project.id),
  };
}

describe("GitLab user assignment", () => {
  it("links SSO by immutable provider ID without needing an exposed email", async () => {
    const own = await context();
    expect(await own.resolve(assignees)).toBe(own.user.id);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
    const identities = await db.select().from(schema.gitlabUserIdentityTable);
    expect(identities).toEqual([
      expect.objectContaining({
        baseUrl: config.baseUrl,
        gitlabUserId: "42",
        userId: own.user.id,
      }),
    ]);
  });

  it("retains the link across email changes and repeated reconciliation", async () => {
    const own = await context(false);
    mocks.getUser.mockResolvedValue({
      id: 42,
      public_email: own.user.email.toUpperCase(),
    });
    expect(await own.resolve(assignees)).toBe(own.user.id);
    await db
      .update(schema.userTable)
      .set({ email: "changed@example.com", emailVerified: false })
      .where(eq(schema.userTable.id, own.user.id));
    mocks.getUser.mockClear();
    expect(
      await createGitlabAssigneeResolver(
        config,
        own.project.id,
      )([{ ...assignees[0]!, username: "renamed" }]),
    ).toBe(own.user.id);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(await db.select().from(schema.gitlabUserIdentityTable)).toHaveLength(
      1,
    );
  });

  it("does not trust an unverified Kaneo email", async () => {
    const own = await context(false);
    await db
      .update(schema.userTable)
      .set({ emailVerified: false })
      .where(eq(schema.userTable.id, own.user.id));
    mocks.getUser.mockResolvedValue({ id: 42, public_email: own.user.email });
    expect(await own.resolve(assignees)).toBeNull();
  });

  it("does not trust an unconfirmed private GitLab email", async () => {
    const own = await context(false);
    mocks.getUser.mockResolvedValue({ id: 42, email: own.user.email });
    expect(await own.resolve(assignees)).toBeNull();
  });

  it("does not link equal SSO IDs belonging to another instance", async () => {
    const own = await context();
    vi.stubEnv(
      "CUSTOM_OAUTH_USER_INFO_URL",
      "https://other.example.com/oauth/userinfo",
    );
    expect(await own.resolve(assignees)).toBeNull();
    expect(await db.select().from(schema.gitlabUserIdentityTable)).toHaveLength(
      0,
    );
  });

  it("does not reassign an established identity when its user loses project access", async () => {
    const own = await context();
    expect(await own.resolve(assignees)).toBe(own.user.id);
    await db.insert(schema.workspaceMemberAccessTable).values({
      workspaceId: own.workspace.id,
      userId: own.user.id,
      projectAccess: "selected",
    });
    expect(await own.resolve(assignees)).toBeNull();
    expect(await db.select().from(schema.gitlabUserIdentityTable)).toEqual([
      expect.objectContaining({ userId: own.user.id }),
    ]);
  });

  it("excludes accounts outside the task workspace", async () => {
    const own = await context(false);
    const foreign = await createWorkspaceMember();
    await db.insert(schema.accountTable).values({
      accountId: "42",
      providerId: "custom",
      userId: foreign.user.id,
    });
    mocks.getUser.mockResolvedValue({
      id: 42,
      public_email: foreign.user.email,
    });
    expect(await own.resolve(assignees)).toBeNull();
  });

  it("selects the first eligible assignee consistently for every viewer", async () => {
    const own = await context();
    const [other] = await db
      .insert(schema.userTable)
      .values({
        email: "other@example.com",
        emailVerified: true,
        name: "Other user",
      })
      .returning();
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: own.workspace.id,
      userId: other.id,
      joinedAt: new Date(),
    });
    await db
      .insert(schema.accountTable)
      .values({ accountId: "43", providerId: "custom", userId: other.id });
    const multiple = [
      ...assignees,
      { id: "43", username: "other", name: "Other", avatarUrl: null },
    ];
    expect(await own.resolve(multiple)).toBe(own.user.id);
    expect(
      await createGitlabAssigneeResolver(config, own.project.id)(multiple),
    ).toBe(own.user.id);
    expect(await own.resolve([...multiple].reverse())).toBe(other.id);
  });

  it("reconciles unchanged snapshots into Home/My Tasks and Inbox exactly once", async () => {
    const own = await context();
    const [integration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: own.project.id,
        type: "gitlab",
        config: JSON.stringify(config),
        isActive: true,
      })
      .returning();
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: own.project.id,
        title: "GitLab work",
        number: 1,
        status: "to-do",
        columnId: own.columns.todo.id,
      })
      .returning();
    await db.insert(schema.externalLinkTable).values({
      taskId: task.id,
      integrationId: integration.id,
      resourceType: "issue",
      externalId: "10",
      url: "https://git.example.com/team/project/-/issues/10",
      metadata: JSON.stringify({ gitlabAssignees: assignees }),
    });
    mocks.listIssues.mockResolvedValue([
      { iid: 10, assignees: [{ id: 42, username: "ada", name: "Ada" }] },
    ]);
    await syncGitlabAssigneesForImportedIssues(own.project.id);
    const mine = await getAssignedTasks(own.workspace.id, own.user.id);
    expect(mine.tasks.map((task) => task.id)).toEqual([task.id]);
    expect(mine.total).toBe(1);
    expect(await getAssignedTasks(own.workspace.id, own.user.id, true)).toEqual(
      { tasks: [], total: 1 },
    );
    expect(await getTask(task.id)).toMatchObject({
      userId: own.user.id,
      assigneeId: own.user.id,
      assigneeName: "Ada",
      assigneeUsername: "@ada",
    });
    const inbox = await db.select().from(schema.notificationTable);
    expect(inbox).toEqual([
      expect.objectContaining({
        userId: own.user.id,
        type: "task_assignee_changed",
        resourceId: task.id,
        isRead: false,
      }),
    ]);
    await syncGitlabAssigneesForImportedIssues(own.project.id);
    expect(await db.select().from(schema.notificationTable)).toHaveLength(1);
    await db
      .update(schema.projectTable)
      .set({ lastTaskNumber: 1 })
      .where(eq(schema.projectTable.id, own.project.id));
    const duplicate = await duplicateTask({
      taskId: task.id,
      currentUserId: own.user.id,
      canUpdateTasks: true,
    });
    expect(duplicate.userId).toBeNull();
    expect((await getAssignedTasks(own.workspace.id, own.user.id)).total).toBe(
      1,
    );
    mocks.listIssues.mockResolvedValue([{ iid: 10, assignees: [] }]);
    await syncGitlabAssigneesForImportedIssues(own.project.id);
    expect((await getAssignedTasks(own.workspace.id, own.user.id)).total).toBe(
      0,
    );
  });

  it("links existing tasks after SSO is added without another GitLab edit", async () => {
    const own = await context(false);
    const [integration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: own.project.id,
        type: "gitlab",
        config: JSON.stringify(config),
        isActive: true,
      })
      .returning();
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: own.project.id,
        title: "Existing imported task",
        number: 1,
        status: "to-do",
        columnId: own.columns.todo.id,
      })
      .returning();
    await db.insert(schema.externalLinkTable).values({
      taskId: task.id,
      integrationId: integration.id,
      resourceType: "issue",
      externalId: "10",
      url: "https://git.example.com/team/project/-/issues/10",
      metadata: JSON.stringify({ gitlabAssignees: assignees }),
    });
    await reconcileGitlabUserAssignments(own.user.id);
    expect((await getAssignedTasks(own.workspace.id, own.user.id)).total).toBe(
      0,
    );
    expect(mocks.getUser).not.toHaveBeenCalled();
    await db
      .insert(schema.accountTable)
      .values({ accountId: "42", providerId: "custom", userId: own.user.id });
    await reconcileGitlabUserAssignments(own.user.id);
    expect(
      (await getAssignedTasks(own.workspace.id, own.user.id)).tasks.map(
        (task) => task.id,
      ),
    ).toEqual([task.id]);
    await reconcileGitlabUserAssignments(own.user.id, own.workspace.id);
    expect(await db.select().from(schema.notificationTable)).toHaveLength(1);
    expect(mocks.listIssues).not.toHaveBeenCalled();
  });

  it("reconciles linked issues beyond the former 5000-issue cap", async () => {
    const own = await context();
    const [integration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: own.project.id,
        type: "gitlab",
        config: JSON.stringify(config),
        isActive: true,
      })
      .returning();
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: own.project.id,
        title: "Older issue",
        number: 1,
        status: "to-do",
        columnId: own.columns.todo.id,
      })
      .returning();
    await db.insert(schema.externalLinkTable).values({
      taskId: task.id,
      integrationId: integration.id,
      resourceType: "issue",
      externalId: "5001",
      url: "https://git.example.com/team/project/-/issues/5001",
    });
    mocks.listIssues.mockImplementation((_project: string, page: number) =>
      page <= 50
        ? Array.from({ length: 100 }, (_value, index) => ({
            iid: (page - 1) * 100 + index + 1,
          }))
        : [
            {
              iid: 5001,
              assignees: [{ id: 42, username: "ada", name: "Ada" }],
            },
          ],
    );
    await syncGitlabAssigneesForImportedIssues(own.project.id);
    expect(mocks.listIssues).toHaveBeenCalledTimes(51);
    expect(
      (await getAssignedTasks(own.workspace.id, own.user.id)).tasks.map(
        (task) => task.id,
      ),
    ).toEqual([task.id]);
  });
});
