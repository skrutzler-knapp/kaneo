import { eq } from "drizzle-orm";
import db from "../../../database";
import { taskTable } from "../../../database/schema";
import { publishEvent } from "../../../events";
import {
  findExternalLink,
  updateExternalLink,
} from "../../github/services/link-manager";
import { updateTaskStatus } from "../../github/services/task-service";
import {
  extractIssuePriority,
  extractIssueStatus,
} from "../../github/utils/extract-priority";
import type { GitlabConfig } from "../config";
import { findAllIntegrationsByGitlabProject } from "../services/integration-lookup";
import { snapshotGitlabAssignees } from "../utils/assignee-sync";
import { taskDescriptionFromIssue } from "../utils/issue-description";
import {
  isEchoOf,
  type LinkMetadata,
  parseLinkSyncMetadata,
} from "../utils/link-sync";
import type {
  GitlabWebhookLabel,
  GitlabWebhookProject,
  GitlabWebhookUser,
} from "../utils/payload";
import { labelTitles } from "../utils/payload";
import { syncGitlabLabelCatalog } from "../utils/sync-gitlab-label-catalog";
import { syncGitlabLabelsToTask } from "../utils/sync-gitlab-labels-to-task";
import { syncGitlabRelationsForIssues } from "../utils/sync-gitlab-task-relations";
import { baseUrlFromProjectWebUrl } from "../utils/webhook-project";

type IssueUpdatedPayload = {
  object_attributes: {
    iid: number;
    title: string;
    description: string | null;
    url: string;
    action?: string;
  };
  assignees?: GitlabWebhookUser[];
  labels?: GitlabWebhookLabel[];
  changes?: {
    title?: { previous?: string | null; current?: string | null };
    description?: { previous?: string | null; current?: string | null };
    assignees?: {
      previous?: GitlabWebhookUser[];
      current?: GitlabWebhookUser[];
    };
    labels?: {
      previous?: GitlabWebhookLabel[];
      current?: GitlabWebhookLabel[];
    };
  };
  project: GitlabWebhookProject;
};

export async function handleGitlabIssueUpdated(
  payload: IssueUpdatedPayload,
  integrationId?: string,
) {
  const issue = payload.object_attributes;
  const { project, changes } = payload;

  const touchedText = Boolean(changes?.title || changes?.description);
  const touchedLabels = Boolean(changes?.labels || payload.labels);
  const touchedAssignees = Boolean(changes?.assignees || payload.assignees);

  const baseUrl = baseUrlFromProjectWebUrl(
    project.web_url,
    project.path_with_namespace,
  );
  if (!baseUrl) return;

  const integrations = await findAllIntegrationsByGitlabProject(
    baseUrl,
    project.path_with_namespace,
    integrationId,
  );
  const currentLabels = payload.labels ?? changes?.labels?.current;

  for (const integration of integrations) {
    try {
      const externalLink = await findExternalLink(
        integration.id,
        "issue",
        issue.iid.toString(),
      );
      if (!externalLink) continue;

      const task = await db.query.taskTable.findFirst({
        where: eq(taskTable.id, externalLink.taskId),
        with: { project: true },
      });
      if (!task) continue;

      const config = JSON.parse(integration.config) as GitlabConfig;
      await syncGitlabRelationsForIssues(
        task.projectId,
        integration.id,
        config.projectPath,
        [issue.iid],
      );
      let metadata: LinkMetadata = parseLinkSyncMetadata(
        externalLink.metadata,
        { externalLinkId: externalLink.id, field: "issue" },
      );

      if (touchedAssignees && config.gitlabOwnsAssignees) {
        const assignees =
          payload.assignees ?? changes?.assignees?.current ?? [];
        const gitlabAssignees = snapshotGitlabAssignees(assignees);
        if (
          JSON.stringify(metadata.gitlabAssignees ?? []) !==
          JSON.stringify(gitlabAssignees)
        ) {
          metadata = { ...metadata, gitlabAssignees };
          await updateExternalLink(externalLink.id, { metadata });
          await publishEvent("task.updated", {
            taskId: task.id,
            projectId: task.projectId,
            title: task.title,
            status: task.status,
            userId: null,
          });
        }
        if (task.userId !== null) {
          await db
            .update(taskTable)
            .set({ userId: null })
            .where(eq(taskTable.id, task.id));
          task.userId = null;
        }
      }

      if (touchedText) {
        const updateData: Record<string, unknown> = {};
        const lastSync = { ...(metadata.lastSync ?? {}) };
        const now = new Date().toISOString();

        if (
          changes?.title &&
          issue.title !== task.title &&
          !isEchoOf(metadata.lastSync?.title, "kaneo", issue.title)
        ) {
          updateData.title = issue.title;
          lastSync.title = {
            timestamp: now,
            source: "gitlab",
            value: issue.title,
          };
        }

        if (changes?.description) {
          const issueBody = issue.description ?? "";
          if (!isEchoOf(metadata.lastSync?.description, "kaneo", issueBody)) {
            const description = taskDescriptionFromIssue(issue.description);
            updateData.description = description;
            lastSync.description = {
              timestamp: now,
              source: "gitlab",
              value: description,
            };
          }
        }

        if (Object.keys(updateData).length > 0) {
          await db
            .update(taskTable)
            .set(updateData)
            .where(eq(taskTable.id, task.id));

          metadata = { ...metadata, lastSync };
          await updateExternalLink(externalLink.id, {
            title: issue.title,
            metadata,
          });

          if (updateData.title !== undefined) {
            await publishEvent("task.title_changed", {
              taskId: task.id,
              projectId: task.projectId,
              userId: null,
              oldTitle: task.title,
              newTitle: issue.title,
            });
          }
        }
      }

      if (!touchedLabels || !currentLabels) {
        continue;
      }

      const titles = labelTitles(currentLabels);
      const priority = extractIssuePriority(titles);
      const status = extractIssueStatus(titles);

      if (priority) {
        await db
          .update(taskTable)
          .set({ priority })
          .where(eq(taskTable.id, task.id));
      }

      // Unrelated label edits also include the full label snapshot. Its status
      // can predate a close/reopen, so only apply an actual status-label change.
      const previousStatus = extractIssueStatus(
        labelTitles(changes?.labels?.previous),
      );
      if (status && status !== previousStatus) {
        const statusResult = await updateTaskStatus(task.id, status);
        if (
          statusResult.applied &&
          statusResult.before.status !== statusResult.after.status
        ) {
          await publishEvent("task.status_changed", {
            sourceIntegrationId: integration.id,
            taskId: statusResult.after.id,
            projectId: statusResult.after.projectId,
            userId: null,
            oldStatus: statusResult.before.status,
            newStatus: statusResult.after.status,
            title: statusResult.after.title,
            assigneeId: config.gitlabOwnsAssignees
              ? null
              : statusResult.after.userId,
            type: "status_changed",
          });
        }
      }

      if (task.project?.workspaceId) {
        try {
          await syncGitlabLabelCatalog(
            config,
            task.projectId,
            task.project.workspaceId,
          );
        } catch (error) {
          console.error("Failed to sync GitLab label catalog:", error);
        }
        const previousLabelNames = new Set(
          labelTitles(changes?.labels?.previous),
        );
        const currentChangedLabelNames = new Set(
          labelTitles(changes?.labels?.current),
        );
        const removedLabelNames = [...previousLabelNames].filter(
          (name) => !currentChangedLabelNames.has(name),
        );

        await syncGitlabLabelsToTask(
          task.id,
          task.projectId,
          task.project.workspaceId,
          currentLabels,
          removedLabelNames,
        );
      }
    } catch (error) {
      console.error("GitLab issue update handler failed for integration", {
        integrationId: integration.id,
        issueIid: issue.iid,
        project: project.path_with_namespace,
        error,
      });
    }
  }
}
