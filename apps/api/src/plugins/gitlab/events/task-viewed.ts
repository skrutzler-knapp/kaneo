import { findExternalLinkByTaskAndType } from "../../github/services/link-manager";
import type { PluginContext, TaskViewedEvent } from "../../types";
import type { GitlabConfig } from "../config";
import { syncGitlabRelationsForIssues } from "../utils/sync-gitlab-task-relations";

// GitLab sends no webhook when related or linked items change.
export async function handleTaskViewed(
  event: TaskViewedEvent,
  context: PluginContext,
): Promise<void> {
  const config = context.config as GitlabConfig;
  if (!config.baseUrl || !config.accessToken || !config.projectPath) return;

  const link = await findExternalLinkByTaskAndType(
    event.taskId,
    context.integrationId,
    "issue",
  );
  if (!link) return;

  const issueIid = Number(link.externalId);
  if (!Number.isSafeInteger(issueIid)) return;

  await syncGitlabRelationsForIssues(
    event.projectId,
    context.integrationId,
    config.projectPath,
    [issueIid],
  );
}
