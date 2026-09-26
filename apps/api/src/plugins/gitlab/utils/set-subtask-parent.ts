import type { GitlabConfig } from "../config";
import { createGitlabClient, GitlabApiError } from "./gitlab-api";

export async function setGitlabSubtaskParent(
  config: GitlabConfig,
  parentIid: number,
  childIid: number,
): Promise<void> {
  const client = createGitlabClient(config);
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
      parentIid,
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

    throw error;
  }
}
