import { findExternalLinkByTaskAndType } from "../../github/services/link-manager";
import type { PluginContext, TaskRelationDeletedEvent } from "../../types";
import type { GitlabConfig } from "../config";
import { deleteRelatedIssueLink } from "../utils/create-related-issue-link";
import { createGitlabClient } from "../utils/gitlab-api";
import { recordGitlabTaskRelation } from "../utils/sync-gitlab-task-relations";

export async function handleTaskRelationDeleted(
  event: TaskRelationDeletedEvent,
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

  const [sourceLink, targetLink] = await Promise.all([
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
  if (!sourceLink || !targetLink) return;

  const sourceIid = Number(sourceLink.externalId);
  const targetIid = Number(targetLink.externalId);
  if (!Number.isSafeInteger(sourceIid) || !Number.isSafeInteger(targetIid)) {
    return;
  }

  if (event.relationType === "subtask") {
    const client = createGitlabClient(config);
    const hierarchy = await client.listSubtaskRelations(config.projectPath, [
      sourceIid,
      targetIid,
    ]);
    const isHierarchyParent = hierarchy.some(
      (relation) =>
        relation.parentIid === sourceIid && relation.childIid === targetIid,
    );
    if (isHierarchyParent) {
      await client.removeSubtaskParent(config.projectPath, targetIid);
    } else {
      await deleteRelatedIssueLink(config, sourceIid, targetIid, "relates_to");
    }
  } else {
    await deleteRelatedIssueLink(
      config,
      sourceIid,
      targetIid,
      event.relationType === "blocks" ? "blocks" : "relates_to",
    );
  }

  await recordGitlabTaskRelation(
    context.integrationId,
    {
      sourceIid,
      targetIid,
      relationType: event.relationType as "subtask" | "related" | "blocks",
    },
    false,
  );
}
