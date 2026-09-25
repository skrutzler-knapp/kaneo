import { boundedTaskRead } from "../bounded-read";
import { alias } from "drizzle-orm/pg-core";
import { boardDescription, descriptionDeferred } from "../description-pages";
import { getSubtaskCounts } from "../get-subtask-counts";
import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  taskTable,
  userTable,
  projectTable,
  taskRelationTable,
  externalLinkTable,
  integrationTable,
} from "../../database/schema";
import { gitlabAssigneeDisplay, gitlabOwnsAssignees, readGitlabAssignees } from "../../plugins/gitlab/utils/assignee-sync";

async function getTask(taskId: string, board = false, userId?: string) {
  const task = await db
    .select({
      id: taskTable.id,
      title: taskTable.title,
      number: taskTable.number,
      description: board ? boardDescription : taskTable.description,
      ...(board
        ? {
            descriptionDeferred,
          }
        : {}),
      status: taskTable.status,
      columnId: taskTable.columnId,
      priority: taskTable.priority,
      startDate: taskTable.startDate,
      dueDate: taskTable.dueDate,
      position: taskTable.position,
      createdAt: taskTable.createdAt,
      userId: taskTable.userId,
      assigneeName: userTable.name,
      assigneeId: userTable.id,
      assigneeImage: userTable.image,
      projectId: taskTable.projectId,
      workspaceId: sql<string>`(select ${projectTable.workspaceId} from ${projectTable} where ${projectTable.id} = ${taskTable.projectId})`,
    })
    .from(taskTable)
    .leftJoin(userTable, eq(taskTable.userId, userTable.id))
    .where(eq(taskTable.id, taskId))
    .limit(1);

  if (!task.length || !task[0]) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  let taskDetails = { ...task[0], assigneeUsername: null as string | null };
  const [externalLink] = await db.select({
    metadata: externalLinkTable.metadata,
    config: integrationTable.config,
  }).from(externalLinkTable).innerJoin(integrationTable, eq(externalLinkTable.integrationId, integrationTable.id))
    .where(and(eq(externalLinkTable.taskId, taskId), eq(externalLinkTable.resourceType, "issue"),
      eq(integrationTable.type, "gitlab"), eq(integrationTable.isActive, true), eq(integrationTable.projectId, taskDetails.projectId))).limit(1);
  if (externalLink && gitlabOwnsAssignees(externalLink.config)) {
    taskDetails = { ...taskDetails, userId: null, assigneeId: null, ...gitlabAssigneeDisplay(readGitlabAssignees(externalLink.metadata)) };
  }
  if (!board) return taskDetails;
  const { workspaceId, ...result } = taskDetails;
  if (!workspaceId) return result;
  const parent = alias(taskTable, "parent");
  const parents = await db
    .selectDistinct({ id: parent.id })
    .from(taskRelationTable)
    .innerJoin(parent, eq(taskRelationTable.sourceTaskId, parent.id))
    .where(
      and(
        eq(taskRelationTable.targetTaskId, taskId),
        eq(taskRelationTable.relationType, "subtask"),
        eq(parent.projectId, result.projectId),
      ),
    );
  const counts = await boundedTaskRead((tx) =>
    getSubtaskCounts(
      tx,
      [taskId, ...parents.map((task) => task.id)],
      workspaceId,
      false,
      userId,
    ),
  );
  return {
    ...result,
    subtaskCounts: counts.get(taskId) ?? { completed: 0, total: 0 },
    parentSubtaskCounts: parents.map(({ id }) => ({
      taskId: id,
      ...(counts.get(id) ?? { completed: 0, total: 0 }),
    })),
  };
}

export default getTask;
