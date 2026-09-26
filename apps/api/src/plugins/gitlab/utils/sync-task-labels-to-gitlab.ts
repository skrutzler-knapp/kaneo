import { getCustomTaskLabelNames } from "../../task-labels";
import type { GitlabConfig } from "../config";
import { addLabelsToIssueGitlab } from "./labels";

export async function syncTaskLabelsToGitlab(
  config: GitlabConfig,
  taskId: string,
  issueIid: number,
): Promise<void> {
  const customLabels = await getCustomTaskLabelNames(taskId);

  if (customLabels.length > 0) {
    await addLabelsToIssueGitlab(config, issueIid, customLabels);
  }
}
