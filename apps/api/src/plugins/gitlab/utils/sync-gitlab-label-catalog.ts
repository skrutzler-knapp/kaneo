import { and, eq, isNull } from "drizzle-orm";
import db from "../../../database";
import { labelTable } from "../../../database/schema";
import { publishEvent } from "../../../events";
import type { GitlabConfig } from "../config";
import { createGitlabClient } from "./gitlab-api";
import type { GitlabWebhookLabel } from "./payload";
import { labelColor } from "./payload";
import { isSystemLabelName } from "./system-labels";

type WorkspaceLabelInput = { name: string; color: string };

async function insertMissingWorkspaceLabels(
  projectId: string,
  workspaceId: string,
  labels: WorkspaceLabelInput[],
): Promise<void> {
  const labelsByName = new Map(
    labels
      .filter((label) => label.name && !isSystemLabelName(label.name))
      .map((label) => [label.name, label]),
  );
  const existingLabels = await db.query.labelTable.findMany({
    where: and(
      eq(labelTable.workspaceId, workspaceId),
      isNull(labelTable.taskId),
    ),
  });
  const existingByName = new Map(
    existingLabels.map((label) => [label.name, label]),
  );
  const missingLabels = [...labelsByName.values()].filter(
    (label) => !existingByName.has(label.name),
  );
  const insertedLabels =
    missingLabels.length > 0
      ? await db
          .insert(labelTable)
          .values(
            missingLabels.map((label) => ({
              name: label.name,
              color: label.color,
              taskId: null,
              workspaceId,
            })),
          )
          .onConflictDoNothing({
            target: [labelTable.workspaceId, labelTable.name],
            where: isNull(labelTable.taskId),
          })
          .returning()
      : [];

  if (insertedLabels.length > 0) {
    await publishEvent("workspace.labels_updated", {
      projectId,
      workspaceId,
    });
  }
}

export async function ensureGitlabWorkspaceLabels(
  projectId: string,
  workspaceId: string,
  webhookLabels: GitlabWebhookLabel[] | undefined,
): Promise<void> {
  await insertMissingWorkspaceLabels(
    projectId,
    workspaceId,
    (webhookLabels ?? []).flatMap((label) =>
      label.title ? [{ name: label.title, color: labelColor(label) }] : [],
    ),
  );
}

export async function syncGitlabLabelCatalog(
  config: GitlabConfig,
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const gitlabLabels = await createGitlabClient(config).listLabels(
    config.projectPath,
  );
  await insertMissingWorkspaceLabels(
    projectId,
    workspaceId,
    gitlabLabels.map((label) => ({
      name: label.name,
      color: label.color?.startsWith("#")
        ? label.color
        : label.color
          ? `#${label.color}`
          : "#6B7280",
    })),
  );
}
