import {
  createExternalLink,
  findExternalLinkByTaskAndType,
  findSubtaskRelationsByTask,
} from "../../github/services/link-manager";
import {
  formatIssueBody,
  formatIssueTitle,
  getLabelsForIssue,
} from "../../github/utils/format";
import type { PluginContext, TaskCreatedEvent } from "../../types";
import type { GitlabConfig } from "../config";
import { createGitlabClient } from "../utils/gitlab-api";
import { addLabelsToIssueGitlab } from "../utils/labels";
import {
  createRelatedIssueLink,
  isUnsupportedGitlabHierarchyParent,
} from "../utils/create-related-issue-link";
import { syncTaskLabelsToGitlab } from "../utils/sync-task-labels-to-gitlab";
import { setGitlabSubtaskParent } from "../utils/set-subtask-parent";
import { recordGitlabTaskRelation } from "../utils/sync-gitlab-task-relations";

async function syncSubtaskRelations(taskId: string, context: PluginContext) {
  const relations = await findSubtaskRelationsByTask(taskId);
  const config = context.config as GitlabConfig;
  for (const relation of relations) {
    const [parentLink, childLink] = await Promise.all([
      findExternalLinkByTaskAndType(
        relation.sourceTaskId,
        context.integrationId,
        "issue",
      ),
      findExternalLinkByTaskAndType(
        relation.targetTaskId,
        context.integrationId,
        "issue",
      ),
    ]);
    if (!parentLink || !childLink) continue;

    const parentIid = Number(parentLink.externalId);
    const childIid = Number(childLink.externalId);
    if (!Number.isSafeInteger(parentIid) || !Number.isSafeInteger(childIid)) {
      continue;
    }

    try {
      await setGitlabSubtaskParent(config, parentIid, childIid);
    } catch (error) {
      if (!isUnsupportedGitlabHierarchyParent(error)) throw error;
      await createRelatedIssueLink(config, parentIid, childIid);
    }
    await recordGitlabTaskRelation(
      context.integrationId,
      { sourceIid: parentIid, targetIid: childIid, relationType: "subtask" },
      true,
    );
  }
}

export async function handleTaskCreated(
  event: TaskCreatedEvent,
  context: PluginContext,
): Promise<void> {
  const config = context.config as GitlabConfig;
  if (!config.baseUrl || !config.accessToken) {
    return;
  }

  const existingLink = await findExternalLinkByTaskAndType(
    event.taskId,
    context.integrationId,
    "issue",
  );

  if (existingLink) {
    await syncTaskLabelsToGitlab(config, event.taskId, Number(existingLink.externalId));
    await syncSubtaskRelations(event.taskId, context);
    return;
  }

  try {
    const relations = await findSubtaskRelationsByTask(event.taskId);
    const isSubtask = relations.some(
      (relation) => relation.targetTaskId === event.taskId,
    );
    const client = createGitlabClient(config);
    const createdIssue = await client.createIssue(config.projectPath, {
      title: formatIssueTitle(event.title),
      description: formatIssueBody(event.description, event.taskId),
      ...(isSubtask ? { issue_type: "task" as const } : {}),
    });

    await createExternalLink({
      taskId: event.taskId,
      integrationId: context.integrationId,
      resourceType: "issue",
      externalId: createdIssue.iid.toString(),
      url: createdIssue.web_url,
      title: createdIssue.title,
      metadata: {
        state: createdIssue.state,
        createdFrom: "kaneo",
        lastOutboundStateSyncAt: Date.now(),
      },
    });

    await syncTaskLabelsToGitlab(config, event.taskId, createdIssue.iid);

    await addLabelsToIssueGitlab(
      config,
      createdIssue.iid,
      getLabelsForIssue(event.priority, event.status),
    );
  } catch (error) {
    console.error("Failed to create GitLab issue:", error);
    return;
  }

  try {
    await syncSubtaskRelations(event.taskId, context);
  } catch (error) {
    console.error("Failed to sync GitLab subtask relations:", error);
  }
}
