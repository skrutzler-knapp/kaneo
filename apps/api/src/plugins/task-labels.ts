import { eq } from "drizzle-orm";
import db from "../database";
import { labelTable } from "../database/schema";

export async function getCustomTaskLabelNames(taskId: string): Promise<string[]> {
  const labels = await db.query.labelTable.findMany({
    where: eq(labelTable.taskId, taskId),
  });

  return labels
    .map((label) => label.name)
    .filter(
      (name) => !name.startsWith("priority:") && !name.startsWith("status:"),
    );
}