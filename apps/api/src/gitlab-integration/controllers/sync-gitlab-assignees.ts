import { and, eq } from "drizzle-orm";
import db from "../../database";
import { externalLinkTable, integrationTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { updateExternalLink } from "../../plugins/github/services/link-manager";
import { withIntegrationLink } from "../../plugins/github/services/with-integration-link";
import { linkedTaskScope } from "../../plugins/github/services/integration-task-scope";
import type { GitlabConfig } from "../../plugins/gitlab/config";
import {
  mergeGitlabAssigneesMetadata,
  readGitlabAssignees,
  snapshotGitlabAssignees,
} from "../../plugins/gitlab/utils/assignee-sync";
import {
  createGitlabClient,
  type GitlabIssue,
} from "../../plugins/gitlab/utils/gitlab-api";
import type { GitlabWebhookUser } from "../../plugins/gitlab/utils/payload";
import { createGitlabAssigneeResolver } from "../../plugins/gitlab/utils/resolve-assignee";
import { syncGitlabTaskAssignee } from "../../plugins/gitlab/utils/sync-task-assignee";

const PER_PAGE = 100;

type GitlabIssueWithAssignees = GitlabIssue & {
  assignee?: GitlabWebhookUser | null;
  assignees?: GitlabWebhookUser[];
};

export async function syncGitlabAssigneesForImportedIssues(
  projectId: string,
): Promise<void> {
  const integration = await db.query.integrationTable.findFirst({
    where: and(
      eq(integrationTable.projectId, projectId),
      eq(integrationTable.type, "gitlab"),
      eq(integrationTable.isActive, true),
    ),
  });
  if (!integration) return;

  const config = JSON.parse(integration.config) as GitlabConfig;
  if (!config.gitlabOwnsAssignees) return;

  const links = await db.query.externalLinkTable.findMany({
    where: and(
      eq(externalLinkTable.integrationId, integration.id),
      eq(externalLinkTable.resourceType, "issue"),
    ),
  });
  if (links.length === 0) return;

  const linkByIid = new Map(links.map((link) => [link.externalId, link]));
  const resolve = createGitlabAssigneeResolver(config, projectId);
  const client = createGitlabClient(config);

  for (let page = 1; linkByIid.size > 0; page++) {
    const issues = await client.listIssues(config.projectPath, page, "all");
    if (issues.length === 0) break;

    for (const issue of issues) {
      const link = linkByIid.get(issue.iid.toString());
      if (!link) continue;
      linkByIid.delete(issue.iid.toString());

      const withAssignees = issue as GitlabIssueWithAssignees;
      const assignees = snapshotGitlabAssignees(
        withAssignees.assignees ??
          (withAssignees.assignee ? [withAssignees.assignee] : []),
      );
      await withIntegrationLink(
        link,
        integration,
        async (database, afterCommit, lockedLink) => {
          const task = await database.query.taskTable.findFirst({
            where: linkedTaskScope(link.taskId, projectId),
          });
          if (!task) return;
          const previousUserId = task.userId;
          const snapshotChanged =
            JSON.stringify(readGitlabAssignees(lockedLink.metadata)) !==
            JSON.stringify(assignees);
          if (snapshotChanged)
            await updateExternalLink(
              link.id,
              {
                metadata: mergeGitlabAssigneesMetadata(
                  lockedLink.metadata,
                  assignees,
                ),
              },
              database,
            );
          await syncGitlabTaskAssignee(
            task,
            assignees,
            resolve,
            integration.id,
            database,
            afterCommit,
          );
          if (snapshotChanged || previousUserId !== task.userId)
            afterCommit(() =>
              publishEvent("task.updated", {
                taskId: task.id,
                projectId,
                title: task.title,
                status: task.status,
                userId: task.userId,
              }),
            );
        },
        { config: integration.config, type: "gitlab" },
      );
    }

    if (issues.length < PER_PAGE) break;
  }
}
