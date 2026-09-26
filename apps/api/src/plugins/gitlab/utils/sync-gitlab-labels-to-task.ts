import { eq, inArray } from "drizzle-orm";
import db from "../../../database";
import { labelTable } from "../../../database/schema";
import { publishEvent } from "../../../events";
import type { GitlabWebhookLabel } from "./payload";
import { labelColor } from "./payload";
import { isSystemLabelName } from "./system-labels";

export async function syncGitlabLabelsToTask(
  taskId: string,
  projectId: string,
  workspaceId: string,
  labels: GitlabWebhookLabel[] | undefined,
  removedLabels: string[] = [],
): Promise<void> {
  const labelsByName = new Map<string, string>();
  for (const label of labels ?? []) {
    if (!label.title || isSystemLabelName(label.title)) continue;
    labelsByName.set(label.title, labelColor(label));
  }

  const existingRows = await db.query.labelTable.findMany({
    where: eq(labelTable.taskId, taskId),
  });
  const existingByName = new Map(
    existingRows.map((label) => [label.name, label]),
  );
  const labelsToInsert = [...labelsByName]
    .filter(([name]) => !existingByName.has(name))
    .map(([name, color]) => ({ name, color, taskId, workspaceId }));

  const insertedLabels =
    labelsToInsert.length > 0
      ? await db
          .insert(labelTable)
          .values(labelsToInsert)
          .onConflictDoNothing({
            target: [labelTable.taskId, labelTable.name],
          })
          .returning()
      : [];

  const updatesByColor = new Map<string, string[]>();
  for (const [name, color] of labelsByName) {
    const existing = existingByName.get(name);
    if (!existing) continue;
    const previousColor = existing.color.startsWith("#")
      ? existing.color
      : `#${existing.color}`;
    if (previousColor === color) continue;
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

  // Absence from GitLab alone does not imply removal: only delete names explicitly removed by this event.
  const removedLabelNames = new Set(removedLabels);
  const labelsToDelete = existingRows
    .filter(
      (label) =>
        removedLabelNames.has(label.name) && !isSystemLabelName(label.name),
    )
    .map((label) => label.id);

  if (labelsToDelete.length > 0) {
    await db.delete(labelTable).where(inArray(labelTable.id, labelsToDelete));
  }

  for (const label of insertedLabels) {
    await publishEvent("task.label_created", {
      projectId,
      taskId,
      userId: null,
      type: "label_created",
      label,
    });
  }

  for (const id of labelsToDelete) {
    const label = existingRows.find((row) => row.id === id);
    if (!label) continue;
    await publishEvent("task.label_unassigned", {
      projectId,
      taskId,
      userId: null,
      type: "label_unassigned",
      label,
    });
  }
}
