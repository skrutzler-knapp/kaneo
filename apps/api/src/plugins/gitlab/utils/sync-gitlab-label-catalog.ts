import { and, eq, inArray, isNull } from "drizzle-orm";
import db from "../../../database";
import { labelTable } from "../../../database/schema";
import { publishEvent } from "../../../events";
import type { GitlabConfig } from "../config";
import { createGitlabClient } from "./gitlab-api";
import { isSystemLabelName } from "./system-labels";

export async function syncGitlabLabelCatalog(
  config: GitlabConfig,
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const gitlabLabels = await createGitlabClient(config).listLabels(
    config.projectPath,
  );
  const labels = gitlabLabels.filter(
    (label) => label.name && !isSystemLabelName(label.name),
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
  const missingLabels = labels.filter(
    (label) => !existingByName.has(label.name),
  );
  const insertedLabels =
    missingLabels.length > 0
      ? await db
          .insert(labelTable)
          .values(
            missingLabels.map((label) => ({
              name: label.name,
              color: label.color?.startsWith("#")
                ? label.color
                : label.color
                  ? `#${label.color}`
                  : "#6B7280",
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

  const updatesByColor = new Map<string, string[]>();
  for (const label of labels) {
    const existing = existingByName.get(label.name);
    if (!existing || !label.color) continue;
    const color = label.color.startsWith("#")
      ? label.color
      : `#${label.color}`;
    if (existing.color === color) continue;
    const ids = updatesByColor.get(color) ?? [];
    ids.push(existing.id);
    updatesByColor.set(color, ids);
  }

  for (const [color, ids] of updatesByColor) {
    await db
      .update(labelTable)
      .set({ color })
      .where(inArray(labelTable.id, ids));
  }

  if (insertedLabels.length > 0 || updatesByColor.size > 0) {
    await publishEvent("workspace.labels_updated", {
      projectId,
      workspaceId,
    });
  }
}