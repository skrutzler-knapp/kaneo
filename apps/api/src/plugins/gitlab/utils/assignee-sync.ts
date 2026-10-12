import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../../database";
import { integrationTable } from "../../../database/schema";
import type { GitlabConfig } from "../config";
import type { GitlabWebhookUser } from "./payload";

export type GitlabAssigneeSnapshot = {
  id: string;
  username: string | null;
  name: string;
  avatarUrl: string | null;
};

export function snapshotGitlabAssignees(
  users: GitlabWebhookUser[] | undefined,
): GitlabAssigneeSnapshot[] {
  return (users ?? []).flatMap((user) => {
    const id =
      user.id === undefined || user.id === null
        ? (user.username?.trim() ?? "")
        : String(user.id);
    if (!id) return [];

    return [
      {
        id,
        username: user.username?.trim() || null,
        name: user.name?.trim() || user.username?.trim() || `GitLab user ${id}`,
        avatarUrl: user.avatar_url ?? null,
      },
    ];
  });
}

export function readGitlabAssignees(
  rawMetadata: string | null | undefined,
): GitlabAssigneeSnapshot[] {
  if (!rawMetadata) return [];

  try {
    const metadata: unknown = JSON.parse(rawMetadata);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return [];
    }

    const assignees = (metadata as Record<string, unknown>).gitlabAssignees;
    if (!Array.isArray(assignees)) return [];

    return assignees.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return [];
      }
      const candidate = value as Record<string, unknown>;
      if (
        typeof candidate.id !== "string" ||
        typeof candidate.name !== "string"
      ) {
        return [];
      }
      return [
        {
          id: candidate.id,
          name: candidate.name,
          username:
            typeof candidate.username === "string" ? candidate.username : null,
          avatarUrl:
            typeof candidate.avatarUrl === "string"
              ? candidate.avatarUrl
              : null,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function mergeGitlabAssigneesMetadata(
  rawMetadata: string | null | undefined,
  assignees: GitlabAssigneeSnapshot[],
): Record<string, unknown> {
  let metadata: Record<string, unknown> = {};
  if (rawMetadata) {
    try {
      const parsed: unknown = JSON.parse(rawMetadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = {};
    }
  }

  return { ...metadata, gitlabAssignees: assignees };
}

export function gitlabAssigneeDisplay(assignees: GitlabAssigneeSnapshot[]) {
  return {
    assigneeName: assignees.map((assignee) => assignee.name).join(", ") || null,
    assigneeUsername:
      assignees
        .map((assignee) =>
          assignee.username ? `@${assignee.username}` : assignee.id,
        )
        .join(", ") || null,
    assigneeImage: assignees[0]?.avatarUrl ?? null,
  };
}

export function gitlabOwnsAssignees(configJson: string | null | undefined) {
  if (!configJson) return false;
  try {
    return (
      (JSON.parse(configJson) as GitlabConfig).gitlabOwnsAssignees === true
    );
  } catch {
    return false;
  }
}

export async function isGitlabAssigneeSourceOfTruth(
  projectId: string,
): Promise<boolean> {
  const integration = await db.query.integrationTable.findFirst({
    where: and(
      eq(integrationTable.projectId, projectId),
      eq(integrationTable.type, "gitlab"),
      eq(integrationTable.isActive, true),
    ),
  });
  return Boolean(integration && gitlabOwnsAssignees(integration.config));
}

export async function assertKaneoCanChangeAssignee(
  projectId: string,
): Promise<void> {
  if (await isGitlabAssigneeSourceOfTruth(projectId)) {
    throw new HTTPException(409, {
      message: "Assignees are managed by the linked GitLab integration",
    });
  }
}
