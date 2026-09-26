import { eq } from "drizzle-orm";
import db from "../database";
import { labelTable } from "../database/schema";

export function containsTaskFieldLabel(labelName: string) {
  // GitLab interprets add_labels/remove_labels as comma-separated names.
  return labelName.split(",").some((name) => {
    const label = name.trim();
    return label.startsWith("priority:") || label.startsWith("status:");
  });
}

export async function getCustomTaskLabelNames(
  taskId: string,
): Promise<string[]> {
  const labels = await db.query.labelTable.findMany({
    where: eq(labelTable.taskId, taskId),
  });

  return labels
    .map((label) => label.name)
    .filter((name) => !containsTaskFieldLabel(name));
}
