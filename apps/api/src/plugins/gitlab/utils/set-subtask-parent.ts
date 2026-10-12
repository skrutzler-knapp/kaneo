import type { GitlabConfig } from "../config";
import { createRelatedIssueLink } from "./create-related-issue-link";
import { createGitlabClient, GitlabApiError } from "./gitlab-api";

export async function setGitlabSubtaskParent(
  config: GitlabConfig,
  parentIid: number,
  childIid: number,
  knownParentIids: number[] = [parentIid],
): Promise<void> {
  const client = createGitlabClient(config);
  const currentRelations = await client.listSubtaskRelations(
    config.projectPath,
    [childIid],
  );
  const currentParent = currentRelations.find(
    (relation) => relation.childIid === childIid,
  )?.parentIid;

  if (currentParent === parentIid) return;
  if (currentParent !== undefined && knownParentIids.includes(currentParent)) {
    await createRelatedIssueLink(config, parentIid, childIid);
    return;
  }

  try {
    await client.setSubtaskParent(config.projectPath, parentIid, childIid);
  } catch (error) {
    if (
      !(error instanceof GitlabApiError) ||
      !/work item\(s\) already assigned/i.test(error.message)
    ) {
      throw error;
    }

    const relations = await client.listSubtaskRelations(config.projectPath, [
      childIid,
    ]);
    if (
      relations.some(
        (relation) =>
          relation.parentIid === parentIid && relation.childIid === childIid,
      )
    ) {
      return;
    }

    const existingParent = relations.find(
      (relation) => relation.childIid === childIid,
    )?.parentIid;
    if (
      existingParent !== undefined &&
      knownParentIids.includes(existingParent)
    ) {
      await createRelatedIssueLink(config, parentIid, childIid);
      return;
    }

    throw error;
  }
}
