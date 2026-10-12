import { setTimeout as delay } from "node:timers/promises";
import * as Sentry from "@sentry/node";
import { assertPublicDestination } from "../../../utils/assert-public-destination";
import type { GitlabConfig, GitlabTokenType } from "../config";
import {
  assertGitlabTransport,
  normalizeGitlabBaseUrl,
  normalizeProjectPath,
} from "../config";

export type GitlabLabel = {
  id: number;
  name: string;
  color?: string;
};

export type GitlabUser = {
  id: number;
  username?: string;
  name?: string;
  avatar_url?: string | null;
};

export type GitlabIssue = {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  web_url: string;
  state: string;
  labels?: string[];
  author?: GitlabUser | null;
  updated_at?: string;
  confidential?: boolean;
};

export type GitlabSubtaskRelation = {
  parentIid: number;
  childIid: number;
};

export type GitlabIssueLink = {
  issue_link_id: number;
  iid: number;
  project_id: number;
  link_type: "relates_to" | "blocks" | "is_blocked_by";
};

export type GitlabNote = {
  id: number;
  body: string;
  system: boolean;
  internal?: boolean;
  author?: GitlabUser | null;
  created_at: string;
};

export type GitlabMergeRequest = {
  iid: number;
  title: string;
  description: string | null;
  web_url: string;
  state: string;
  draft?: boolean;
  source_branch?: string;
  author?: GitlabUser | null;
  merged_at?: string | null;
};

export type GitlabProject = {
  id: number;
  name: string;
  path_with_namespace: string;
  name_with_namespace: string;
  visibility: string;
  web_url: string;
  permissions?: {
    project_access?: { access_level?: number } | null;
    group_access?: { access_level?: number } | null;
  } | null;
};

export type GitlabApiErrorKind =
  | "REDIRECT"
  | "INVALID_JSON"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "EMPTY_RESPONSE";

export class GitlabApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public kind: GitlabApiErrorKind,
    public body?: string,
  ) {
    super(message);
    this.name = "GitlabApiError";
  }
}

function isResourceLock(error: unknown): boolean {
  if (!(error instanceof GitlabApiError) || error.status !== 409) return false;
  try {
    return (
      JSON.parse(error.body ?? "null")?.message ===
      "409 Conflict: Resource lock"
    );
  } catch {
    return false;
  }
}

function authHeaders(token: string, tokenType: GitlabTokenType): HeadersInit {
  return {
    ...(tokenType === "bearer"
      ? { Authorization: `Bearer ${token}` }
      : { "PRIVATE-TOKEN": token }),
    "Content-Type": "application/json",
  };
}

const GITLAB_FETCH_TIMEOUT_MS = 10_000;
const WORK_ITEM_HIERARCHY_QUERY = `
  query GitLabWorkItemHierarchy($fullPath: ID!, $iids: [String!]!) {
    project(fullPath: $fullPath) {
      workItems(iids: $iids) {
        nodes {
          iid
          widgets {
            type
            ... on WorkItemWidgetHierarchy {
              parent { iid }
              children(first: 100) { nodes { iid } }
            }
          }
        }
      }
    }
  }
`;
const WORK_ITEM_IDS_QUERY = `
  query GitLabWorkItemIds($fullPath: ID!, $iids: [String!]!) {
    project(fullPath: $fullPath) {
      workItems(iids: $iids) {
        nodes { id iid }
      }
    }
  }
`;
const SET_WORK_ITEM_PARENT_MUTATION = `
  mutation SetGitLabWorkItemParent($childId: WorkItemID!, $parentId: WorkItemID) {
    workItemsHierarchyReorder(input: { id: $childId, parentId: $parentId }) {
      errors
      workItem { iid }
      parentWorkItem { iid }
    }
  }
`;

type GitlabGraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

type GitlabHierarchyNode = {
  iid: string;
  widgets: Array<{
    type: string;
    parent?: { iid: string } | null;
    children?: { nodes: Array<{ iid: string }> } | null;
  }>;
};

type GitlabHierarchyData = {
  project: {
    workItems: { nodes: GitlabHierarchyNode[] };
  } | null;
};

export async function gitlabFetch<T>(
  baseUrl: string,
  token: string,
  tokenType: GitlabTokenType,
  path: string,
  init?: RequestInit,
  apiVersion: "v4" | "graphql" = "v4",
): Promise<T | undefined> {
  const root = normalizeGitlabBaseUrl(baseUrl);
  const url =
    apiVersion === "graphql"
      ? `${root}/api/graphql`
      : `${root}/api/v4${path.startsWith("/") ? path : `/${path}`}`;

  await assertPublicDestination(root, "GitLab");
  assertGitlabTransport(root);

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, GITLAB_FETCH_TIMEOUT_MS);
  if (init?.signal) {
    if (init.signal.aborted) {
      controller.abort();
    } else {
      init.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  try {
    Sentry.addBreadcrumb({
      category: "integration",
      level: "info",
      data: { integration: "gitlab" },
    });
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      // A redirect could lead past the destination check to an internal host.
      redirect: "manual",
      headers: {
        ...authHeaders(token, tokenType),
        ...init?.headers,
      },
    });

    if (res.status >= 300 && res.status < 400) {
      throw new GitlabApiError(
        `GitLab request was redirected (HTTP ${res.status})`,
        res.status,
        "REDIRECT",
      );
    }

    const text = await res.text();
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new GitlabApiError(
        `GitLab API error ${res.status}`,
        res.status,
        "HTTP_ERROR",
        text,
      );
    }

    if (res.status === 204 || text === "") {
      return undefined;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GitlabApiError(
        "GitLab API returned invalid JSON",
        res.status,
        "INVALID_JSON",
        text,
      );
    }
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof GitlabApiError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      if (timedOut) {
        throw new GitlabApiError(
          `GitLab request timed out after ${GITLAB_FETCH_TIMEOUT_MS}ms`,
          408,
          "TIMEOUT",
        );
      }
      throw error;
    }
    throw error;
  }
}

export function tokenTypeOf(config: {
  tokenType?: GitlabTokenType;
}): GitlabTokenType {
  return config.tokenType === "bearer" ? "bearer" : "private";
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new GitlabApiError(
      `GitLab ${what} response was empty`,
      500,
      "EMPTY_RESPONSE",
    );
  }
  return value;
}

export function createGitlabClient(
  config: Pick<GitlabConfig, "baseUrl" | "accessToken" | "tokenType">,
) {
  const { baseUrl, accessToken } = config;
  const tokenType = tokenTypeOf(config);
  const project = (path: string) =>
    `/projects/${encodeURIComponent(normalizeProjectPath(path))}`;

  const call = <T>(path: string, init?: RequestInit) =>
    gitlabFetch<T>(baseUrl, accessToken, tokenType, path, init);
  const graphql = async <T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> => {
    const response = required(
      await gitlabFetch<GitlabGraphqlResponse<T>>(
        baseUrl,
        accessToken,
        tokenType,
        "",
        { method: "POST", body: JSON.stringify({ query, variables }) },
        "graphql",
      ),
      "GraphQL response",
    );
    if (response.errors?.length) {
      throw new GitlabApiError(
        response.errors.map((error) => error.message).join("; "),
        400,
        "HTTP_ERROR",
      );
    }
    if (response.data === undefined) {
      throw new GitlabApiError(
        "GitLab GraphQL response did not include data",
        500,
        "EMPTY_RESPONSE",
      );
    }
    return response.data;
  };

  return {
    async getProject(projectPath: string): Promise<GitlabProject> {
      return required(
        await call<GitlabProject>(project(projectPath)),
        "project",
      );
    },

    async listMemberProjects(page = 1, perPage = 50): Promise<GitlabProject[]> {
      return required(
        await call<GitlabProject[]>(
          `/projects?membership=true&simple=true&order_by=last_activity_at&per_page=${perPage}&page=${page}`,
        ),
        "projects",
      );
    },

    async createIssue(
      projectPath: string,
      body: { title: string; description?: string | null },
    ): Promise<GitlabIssue> {
      return required(
        await call<GitlabIssue>(`${project(projectPath)}/issues`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
        "create issue",
      );
    },

    async updateIssue(
      projectPath: string,
      iid: number,
      body: Record<string, unknown>,
    ): Promise<GitlabIssue> {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return required(
            await call<GitlabIssue>(`${project(projectPath)}/issues/${iid}`, {
              method: "PUT",
              body: JSON.stringify(body),
            }),
            "update issue",
          );
        } catch (error) {
          // Concurrent edits can briefly lock an issue. Retry only this rejected
          // update, not creates or ambiguous failures that may have succeeded.
          if (attempt >= 3 || !isResourceLock(error)) {
            throw error;
          }
          await delay(250 * 2 ** attempt);
        }
      }
    },

    async getIssue(projectPath: string, iid: number): Promise<GitlabIssue> {
      return required(
        await call<GitlabIssue>(`${project(projectPath)}/issues/${iid}`),
        "issue",
      );
    },

    async listIssueLinks(
      projectPath: string,
      iid: number,
    ): Promise<GitlabIssueLink[]> {
      return required(
        await call<GitlabIssueLink[]>(
          `${project(projectPath)}/issues/${iid}/links`,
        ),
        "issue links",
      );
    },

    async deleteIssueLink(
      projectPath: string,
      iid: number,
      issueLinkId: number,
      linkType: GitlabIssueLink["link_type"],
    ): Promise<void> {
      await call<void>(
        `${project(projectPath)}/issues/${iid}/links/${issueLinkId}?link_type=${linkType}`,
        { method: "DELETE" },
      );
    },

    async listIssues(
      projectPath: string,
      page: number,
      state: "opened" | "closed" | "all",
    ): Promise<GitlabIssue[]> {
      return required(
        await call<GitlabIssue[]>(
          `${project(projectPath)}/issues?state=${state}&order_by=created_at&sort=asc&per_page=100&page=${page}`,
        ),
        "issues",
      );
    },

    async listSubtaskRelations(
      projectPath: string,
      issueIids: number[],
    ): Promise<GitlabSubtaskRelation[]> {
      const relations = new Map<string, GitlabSubtaskRelation>();
      const uniqueIids = [...new Set(issueIids)].map(String);

      for (let offset = 0; offset < uniqueIids.length; offset += 50) {
        const response = await graphql<GitlabHierarchyData>(
          WORK_ITEM_HIERARCHY_QUERY,
          {
            fullPath: normalizeProjectPath(projectPath),
            iids: uniqueIids.slice(offset, offset + 50),
          },
        );
        const project = required(response.project ?? undefined, "project");

        for (const workItem of project.workItems.nodes) {
          const hierarchy = workItem.widgets.find(
            (widget) => widget.type === "HIERARCHY",
          );
          if (!hierarchy) continue;

          const addRelation = (parentValue: string, childValue: string) => {
            const parentIid = Number(parentValue);
            const childIid = Number(childValue);
            if (
              !Number.isSafeInteger(parentIid) ||
              !Number.isSafeInteger(childIid) ||
              parentIid === childIid
            ) {
              return;
            }
            relations.set(`${parentIid}:${childIid}`, {
              parentIid,
              childIid,
            });
          };

          if (hierarchy.parent) {
            addRelation(hierarchy.parent.iid, workItem.iid);
          }
          for (const child of hierarchy.children?.nodes ?? []) {
            addRelation(workItem.iid, child.iid);
          }
        }
      }

      return [...relations.values()];
    },

    async setSubtaskParent(
      projectPath: string,
      parentIid: number,
      childIid: number,
    ): Promise<void> {
      const projectPathValue = normalizeProjectPath(projectPath);
      const result = await graphql<{
        project: {
          workItems: { nodes: Array<{ id: string; iid: string }> };
        } | null;
      }>(WORK_ITEM_IDS_QUERY, {
        fullPath: projectPathValue,
        iids: [String(parentIid), String(childIid)],
      });
      const workItems = result.project?.workItems.nodes ?? [];
      const parent = workItems.find((item) => Number(item.iid) === parentIid);
      const child = workItems.find((item) => Number(item.iid) === childIid);
      if (!parent || !child) {
        throw new GitlabApiError(
          "GitLab parent or child work item could not be found",
          404,
          "HTTP_ERROR",
        );
      }

      const mutationResult = await graphql<{
        workItemsHierarchyReorder: {
          errors: string[];
          workItem: { iid: string } | null;
        };
      }>(SET_WORK_ITEM_PARENT_MUTATION, {
        parentId: parent.id,
        childId: child.id,
      });
      const mutation = mutationResult.workItemsHierarchyReorder;
      if (mutation.errors.length > 0 || !mutation.workItem) {
        throw new GitlabApiError(
          mutation.errors.join("; ") || "GitLab did not update the hierarchy",
          400,
          "HTTP_ERROR",
        );
      }
    },

    async removeSubtaskParent(
      projectPath: string,
      childIid: number,
    ): Promise<void> {
      const projectPathValue = normalizeProjectPath(projectPath);
      const result = await graphql<{
        project: {
          workItems: { nodes: Array<{ id: string; iid: string }> };
        } | null;
      }>(WORK_ITEM_IDS_QUERY, {
        fullPath: projectPathValue,
        iids: [String(childIid)],
      });
      const child = result.project?.workItems.nodes.find(
        (item) => Number(item.iid) === childIid,
      );
      if (!child) {
        throw new GitlabApiError(
          "GitLab child work item could not be found",
          404,
          "HTTP_ERROR",
        );
      }

      const mutationResult = await graphql<{
        workItemsHierarchyReorder: {
          errors: string[];
          workItem: { iid: string } | null;
        };
      }>(SET_WORK_ITEM_PARENT_MUTATION, {
        parentId: null,
        childId: child.id,
      });
      const mutation = mutationResult.workItemsHierarchyReorder;
      if (mutation.errors.length > 0 || !mutation.workItem) {
        throw new GitlabApiError(
          mutation.errors.join("; ") || "GitLab did not remove the hierarchy",
          400,
          "HTTP_ERROR",
        );
      }
    },

    async listIssueNotes(
      projectPath: string,
      iid: number,
      page: number,
      perPage: number,
    ): Promise<GitlabNote[]> {
      return required(
        await call<GitlabNote[]>(
          `${project(projectPath)}/issues/${iid}/notes?sort=asc&order_by=created_at&per_page=${perPage}&page=${page}`,
        ),
        "notes",
      );
    },

    async createIssueNote(
      projectPath: string,
      iid: number,
      body: string,
    ): Promise<GitlabNote> {
      return required(
        await call<GitlabNote>(`${project(projectPath)}/issues/${iid}/notes`, {
          method: "POST",
          body: JSON.stringify({ body }),
        }),
        "create note",
      );
    },

    async listLabels(projectPath: string): Promise<GitlabLabel[]> {
      const all: GitlabLabel[] = [];
      let page = 1;

      while (page <= 20) {
        const batch = required(
          await call<GitlabLabel[]>(
            `${project(projectPath)}/labels?per_page=100&page=${page}`,
          ),
          "labels",
        );
        all.push(...batch);
        if (batch.length < 100) break;
        page += 1;
      }

      return all;
    },

    async createLabel(
      projectPath: string,
      name: string,
      color: string,
    ): Promise<GitlabLabel> {
      return required(
        await call<GitlabLabel>(`${project(projectPath)}/labels`, {
          method: "POST",
          body: JSON.stringify({
            name,
            color: `#${color.replace(/^#/, "")}`,
          }),
        }),
        "create label",
      );
    },

    async listMergeRequests(
      projectPath: string,
      page: number,
    ): Promise<GitlabMergeRequest[]> {
      return required(
        await call<GitlabMergeRequest[]>(
          `${project(projectPath)}/merge_requests?state=opened&per_page=100&page=${page}`,
        ),
        "merge requests",
      );
    },
  };
}

export async function verifyGitlabToken(
  baseUrl: string,
  token: string,
  tokenType: GitlabTokenType,
) {
  return required(
    await gitlabFetch<{ id: number; username: string }>(
      normalizeGitlabBaseUrl(baseUrl),
      token,
      tokenType,
      "/user",
    ),
    "user",
  );
}
