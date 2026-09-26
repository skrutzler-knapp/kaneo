import type { GitlabConfig } from "../config";
import {
  GitlabApiError,
  createGitlabClient,
  gitlabFetch,
  tokenTypeOf,
} from "./gitlab-api";
import { normalizeProjectPath } from "../config";
import type { GitlabIssueLink } from "./gitlab-api";

export function isUnsupportedGitlabHierarchyParent(error: unknown): boolean {
  return (
    error instanceof GitlabApiError &&
    /cannot be added.*not allowed to add this type of parent item/i.test(
      error.message,
    )
  );
}

export async function createRelatedIssueLink(
  config: GitlabConfig,
  parentIid: number,
  childIid: number,
  linkType: GitlabIssueLink["link_type"] = "relates_to",
): Promise<void> {
  const project = await createGitlabClient(config).getProject(config.projectPath);
  const path = `/projects/${encodeURIComponent(normalizeProjectPath(config.projectPath))}/issues/${parentIid}/links`;
  const links =
    (await gitlabFetch<GitlabIssueLink[]>(
      config.baseUrl,
      config.accessToken,
      tokenTypeOf(config),
      path,
    )) ?? [];
  const alreadyLinked = links.some(
    (link) =>
      link.link_type === linkType &&
      link.iid === childIid &&
      link.project_id === project.id,
  );

  if (alreadyLinked) return;

  try {
    await gitlabFetch(
      config.baseUrl,
      config.accessToken,
      tokenTypeOf(config),
      path,
      {
        method: "POST",
        body: JSON.stringify({
          target_project_id: project.id,
          target_issue_iid: childIid,
          link_type: linkType,
        }),
      },
    );
  } catch (error) {
    if (!(error instanceof GitlabApiError) || error.status !== 409) throw error;
  }
}

export async function deleteRelatedIssueLink(
  config: GitlabConfig,
  sourceIid: number,
  targetIid: number,
  linkType: GitlabIssueLink["link_type"],
): Promise<void> {
  const client = createGitlabClient(config);
  const links = await client.listIssueLinks(config.projectPath, sourceIid);
  const link = links.find(
    (candidate) =>
      candidate.iid === targetIid && candidate.link_type === linkType,
  );
  if (!link) return;
  await client.deleteIssueLink(
    config.projectPath,
    sourceIid,
    link.issue_link_id,
    linkType,
  );
}