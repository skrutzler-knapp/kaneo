import { and, asc, eq, gt } from "drizzle-orm";
import db from "../../database";
import {
  externalLinkTable,
  accountTable,
  gitlabUserIdentityTable,
  integrationTable,
  projectTable,
  taskTable,
  workspaceUserTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { projectAccessCondition } from "../../project-access/project-access-condition";
import { linkedTaskScope } from "../../plugins/github/services/integration-task-scope";
import { withIntegrationLink } from "../../plugins/github/services/with-integration-link";
import {
  normalizeGitlabBaseUrl,
  type GitlabConfig,
} from "../../plugins/gitlab/config";
import { gitlabSsoMatchesInstance } from "../../plugins/gitlab/utils/gitlab-sso-instance";
import {
  gitlabOwnsAssignees,
  readGitlabAssignees,
} from "../../plugins/gitlab/utils/assignee-sync";
import { createGitlabAssigneeResolver } from "../../plugins/gitlab/utils/resolve-assignee";
import { syncGitlabTaskAssignee } from "../../plugins/gitlab/utils/sync-task-assignee";

export async function reconcileGitlabUserAssignments(
  userId: string,
  workspaceId?: string,
): Promise<void> {
  const integrations = await db
    .select({ integration: integrationTable })
    .from(integrationTable)
    .innerJoin(projectTable, eq(projectTable.id, integrationTable.projectId))
    .innerJoin(
      workspaceUserTable,
      eq(workspaceUserTable.workspaceId, projectTable.workspaceId),
    )
    .where(
      and(
        eq(workspaceUserTable.userId, userId),
        eq(integrationTable.type, "gitlab"),
        eq(integrationTable.isActive, true),
        workspaceId ? eq(projectTable.workspaceId, workspaceId) : undefined,
        projectAccessCondition(userId, projectTable.id),
      ),
    );
  for (const { integration } of integrations) {
    if (!gitlabOwnsAssignees(integration.config)) continue;
    const config = JSON.parse(integration.config) as GitlabConfig;
    const resolve = createGitlabAssigneeResolver(config, integration.projectId);
    const identities = await db
      .select({ id: gitlabUserIdentityTable.gitlabUserId })
      .from(gitlabUserIdentityTable)
      .where(
        and(
          eq(gitlabUserIdentityTable.userId, userId),
          eq(
            gitlabUserIdentityTable.baseUrl,
            normalizeGitlabBaseUrl(config.baseUrl),
          ),
        ),
      );
    const accounts = gitlabSsoMatchesInstance(config.baseUrl)
      ? await db
          .select({ id: accountTable.accountId })
          .from(accountTable)
          .where(
            and(
              eq(accountTable.userId, userId),
              eq(accountTable.providerId, "custom"),
            ),
          )
      : [];
    const targetIds = new Set(
      [...identities, ...accounts].map((identity) => identity.id),
    );
    let cursor: string | undefined;
    for (;;) {
      const links = await db
        .select({ link: externalLinkTable, assignedUserId: taskTable.userId })
        .from(externalLinkTable)
        .innerJoin(
          taskTable,
          and(
            eq(taskTable.id, externalLinkTable.taskId),
            eq(taskTable.projectId, integration.projectId),
          ),
        )
        .where(
          and(
            eq(externalLinkTable.integrationId, integration.id),
            eq(externalLinkTable.resourceType, "issue"),
            cursor ? gt(externalLinkTable.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(externalLinkTable.id))
        .limit(100);
      for (const { link, assignedUserId } of links) {
        if (
          assignedUserId !== userId &&
          !readGitlabAssignees(link.metadata).some((assignee) =>
            targetIds.has(assignee.id),
          )
        )
          continue;
        await withIntegrationLink(
          link,
          integration,
          async (database, afterCommit, lockedLink) => {
            const task = await database.query.taskTable.findFirst({
              where: linkedTaskScope(link.taskId, integration.projectId),
            });
            if (!task) return;
            const assignees = readGitlabAssignees(lockedLink.metadata);
            const resolvedUserId = await resolve(assignees, database);
            if (resolvedUserId !== userId && task.userId !== userId) return;
            const previousUserId = task.userId;
            await syncGitlabTaskAssignee(
              task,
              assignees,
              async () => resolvedUserId,
              integration.id,
              database,
              afterCommit,
            );
            if (previousUserId !== task.userId)
              afterCommit(() =>
                publishEvent("task.updated", {
                  taskId: task.id,
                  projectId: task.projectId,
                  userId: task.userId,
                }),
              );
          },
          { config: integration.config, type: "gitlab" },
        );
      }
      if (links.length < 100) break;
      cursor = links.at(-1)!.link.id;
    }
  }
}
