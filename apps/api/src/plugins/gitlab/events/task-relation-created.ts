import { findExternalLinkByTaskAndType } from "../../github/services/link-manager";
import type { PluginContext, TaskRelationCreatedEvent } from "../../types";
import type { GitlabConfig } from "../config";
import {
  createRelatedIssueLink,
  isUnsupportedGitlabHierarchyParent,
} from "../utils/create-related-issue-link";
import { setGitlabSubtaskParent } from "../utils/set-subtask-parent";
import { recordGitlabTaskRelation } from "../utils/sync-gitlab-task-relations";

export async function handleTaskRelationCreated(
  event: TaskRelationCreatedEvent,
  context: PluginContext,
): Promise<void> {
  if (event.source === "gitlab") return;
  if (
    !(["subtask", "related", "blocks"] as string[]).includes(event.relationType)
  ) {
    return;
  }

  const config = context.config as GitlabConfig;
  if (!config.baseUrl || !config.accessToken) return;

  const [parentLink, childLink] = await Promise.all([
    findExternalLinkByTaskAndType(
      event.sourceTaskId,
      context.integrationId,
      "issue",
    ),
    findExternalLinkByTaskAndType(
      event.targetTaskId,
      context.integrationId,
      "issue",
    ),
  ]);
  if (!parentLink || !childLink) return;

  const parentIid = Number(parentLink.externalId);
  const childIid = Number(childLink.externalId);
  if (!Number.isSafeInteger(parentIid) || !Number.isSafeInteger(childIid)) {
    return;
  }

  if (event.relationType === "subtask") {
    try {
      await setGitlabSubtaskParent(config, parentIid, childIid);
    } catch (error) {
      if (!isUnsupportedGitlabHierarchyParent(error)) throw error;
      await createRelatedIssueLink(config, parentIid, childIid);
    }
  }

  if (event.relationType === "related") {
    await createRelatedIssueLink(config, parentIid, childIid, "relates_to");
  } else if (event.relationType === "blocks") {
    await createRelatedIssueLink(config, parentIid, childIid, "blocks");
  }

  await recordGitlabTaskRelation(
    context.integrationId,
    {
      sourceIid: parentIid,
      targetIid: childIid,
      relationType: event.relationType as "subtask" | "related" | "blocks",
    },
    true,
  );
}
