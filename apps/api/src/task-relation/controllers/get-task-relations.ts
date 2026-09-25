import { and, eq, inArray, or } from "drizzle-orm";
import db from "../../database";
import {
  projectTable,
  taskRelationTable,
  taskTable,
  userTable,
} from "../../database/schema";
import { projectAccessCondition } from "../../project-access/project-access-condition";
import { taskIsCompleted } from "../../task/task-is-completed";

async function getTaskRelations(
  taskId: string,
  workspaceId: string,
  userId: string,
) {
  return getRelationsForTaskIds([taskId], workspaceId, userId);
}

async function getProjectTaskRelations(projectId: string, workspaceId: string, userId: string) {
  const projectTasks = await db
    .select({ id: taskTable.id })
    .from(taskTable)
    .where(eq(taskTable.projectId, projectId));

  return getRelationsForTaskIds(
    projectTasks.map((task) => task.id),
    workspaceId,
    userId,
  );
}

async function getRelationsForTaskIds(
  taskIdsInScope: string[],
  workspaceId: string,
  userId: string,
) {
  if (taskIdsInScope.length === 0) return [];

  const relations = await db
    .select({
      id: taskRelationTable.id,
      sourceTaskId: taskRelationTable.sourceTaskId,
      targetTaskId: taskRelationTable.targetTaskId,
      relationType: taskRelationTable.relationType,
      createdAt: taskRelationTable.createdAt,
    })
    .from(taskRelationTable)
    .where(
      or(
        inArray(taskRelationTable.sourceTaskId, taskIdsInScope),
        inArray(taskRelationTable.targetTaskId, taskIdsInScope),
      ),
    );

  const taskIds = new Set<string>();
  for (const rel of relations) {
    taskIds.add(rel.sourceTaskId);
    taskIds.add(rel.targetTaskId);
  }

  const tasks = new Map<
    string,
    {
      id: string;
      title: string;
      status: string;
      isCompleted: boolean;
      priority: string | null;
      number: number | null;
      projectId: string;
      userId: string | null;
      assigneeName: string | null;
    }
  >();

  if (taskIds.size > 0) {
    const taskRows = await db
      .select({
        id: taskTable.id,
        title: taskTable.title,
        status: taskTable.status,
        isCompleted: taskIsCompleted,
        priority: taskTable.priority,
        number: taskTable.number,
        projectId: taskTable.projectId,
        userId: taskTable.userId,
        assigneeName: userTable.name,
      })
      .from(taskTable)
      .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
      .leftJoin(userTable, eq(taskTable.userId, userTable.id))
      .where(
        and(
          inArray(taskTable.id, [...taskIds]),
          eq(projectTable.workspaceId, workspaceId),
          projectAccessCondition(userId, projectTable.id),
        ),
      );

    for (const task of taskRows) {
      tasks.set(task.id, task);
    }
  }

  return relations
    .filter((rel) => tasks.has(rel.sourceTaskId) && tasks.has(rel.targetTaskId))
    .map((rel) => ({
      ...rel,
      sourceTask: tasks.get(rel.sourceTaskId) ?? null,
      targetTask: tasks.get(rel.targetTaskId) ?? null,
    }));
}

export { getProjectTaskRelations };
export default getTaskRelations;
