import { and, eq, inArray, isNotNull } from "drizzle-orm";
import db from "../../database";
import {
  externalLinkTable,
  integrationTable,
  taskTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { updateExternalLink } from "../../plugins/github/services/link-manager";
import type { GitlabConfig } from "../../plugins/gitlab/config";
import { createGitlabClient, type GitlabIssue } from "../../plugins/gitlab/utils/gitlab-api";
import {
  mergeGitlabAssigneesMetadata,
  readGitlabAssignees,
  snapshotGitlabAssignees,
} from "../../plugins/gitlab/utils/assignee-sync";
import type { GitlabWebhookUser } from "../../plugins/gitlab/utils/payload";

const PER_PAGE = 100;
const MAX_PAGES = 50;

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
  const taskIds = [...new Set(links.map((link) => link.taskId))];
  const tasks = await db
    .select({
      id: taskTable.id,
      title: taskTable.title,
      status: taskTable.status,
      userId: taskTable.userId,
    })
    .from(taskTable)
    .where(inArray(taskTable.id, taskIds));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const legacyAssignments = tasks.filter((task) => task.userId !== null);
  if (legacyAssignments.length > 0) {
    await db
      .update(taskTable)
      .set({ userId: null })
      .where(
        and(
          inArray(
            taskTable.id,
            legacyAssignments.map((task) => task.id),
          ),
          isNotNull(taskTable.userId),
        ),
      );
    for (const task of legacyAssignments) {
      await publishEvent("task.unassigned", {
        taskId: task.id,
        projectId,
        userId: null,
        title: task.title,
        type: "unassigned",
      });
      task.userId = null;
    }
  }
  const client = createGitlabClient(config);

  for (let page = 1; page <= MAX_PAGES; page++) {
    const issues = await client.listIssues(config.projectPath, page, "all");
    if (issues.length === 0) break;

    for (const issue of issues) {
      const link = linkByIid.get(issue.iid.toString());
      if (!link) continue;

      const withAssignees = issue as GitlabIssueWithAssignees;
      const assignees = snapshotGitlabAssignees(
        withAssignees.assignees ??
          (withAssignees.assignee ? [withAssignees.assignee] : []),
      );
      const previousAssignees = readGitlabAssignees(link.metadata);
      if (JSON.stringify(previousAssignees) === JSON.stringify(assignees)) {
        continue;
      }

      await updateExternalLink(link.id, {
        metadata: mergeGitlabAssigneesMetadata(link.metadata, assignees),
      });

      const task = taskById.get(link.taskId);
      if (task) {
        await publishEvent("task.updated", {
          taskId: task.id,
          projectId,
          title: task.title,
          status: task.status,
          userId: null,
        });
      }
    }

    if (issues.length < PER_PAGE) break;
  }
}
