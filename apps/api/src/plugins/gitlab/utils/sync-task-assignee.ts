import { taskTable } from "../../../database/schema";
import { publishTaskMutation } from "../../../task/controllers/task-mutation-effects";
import {
  linkedTaskScope,
  type IntegrationDatabase,
} from "../../github/services/integration-task-scope";
import type { GitlabAssigneeSnapshot } from "./assignee-sync";
import type { createGitlabAssigneeResolver } from "./resolve-assignee";

export async function syncGitlabTaskAssignee(
  task: Pick<
    typeof taskTable.$inferSelect,
    "id" | "projectId" | "title" | "userId"
  >,
  assignees: GitlabAssigneeSnapshot[],
  resolve: ReturnType<typeof createGitlabAssigneeResolver>,
  integrationId: string,
  database: IntegrationDatabase,
  afterCommit: (effect: () => Promise<void>) => void,
) {
  const userId = await resolve(assignees, database);
  if (task.userId === userId) return;
  const before = { ...task };
  await database
    .update(taskTable)
    .set({ userId })
    .where(linkedTaskScope(task.id, task.projectId));
  task.userId = userId;
  afterCommit(() =>
    publishTaskMutation(before, { ...task, userId }, undefined, {
      fields: ["userId"],
      sourceIntegrationId: integrationId,
    }),
  );
}
