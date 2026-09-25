import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  externalLinkTable,
  integrationTable,
  taskTable,
  userTable,
} from "../../database/schema";
import {
  gitlabAssigneeDisplay,
  gitlabOwnsAssignees,
  readGitlabAssignees,
} from "../../plugins/gitlab/utils/assignee-sync";

async function getTask(taskId: string) {
  const task = await db
    .select({
      id: taskTable.id,
      title: taskTable.title,
      number: taskTable.number,
      description: taskTable.description,
      status: taskTable.status,
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

  const [externalLink] = await db
    .select({
      resourceType: externalLinkTable.resourceType,
      metadata: externalLinkTable.metadata,
      integrationType: integrationTable.type,
      integrationIsActive: integrationTable.isActive,
      integrationConfig: integrationTable.config,
    })
    .from(externalLinkTable)
    .innerJoin(
      integrationTable,
      eq(externalLinkTable.integrationId, integrationTable.id),
    )
    .where(
      and(
        eq(externalLinkTable.taskId, taskId),
        eq(externalLinkTable.resourceType, "issue"),
        eq(integrationTable.type, "gitlab"),
        eq(integrationTable.isActive, true),
        eq(integrationTable.projectId, task[0].projectId),
      ),
    )
    .limit(1);

  if (
    externalLink?.resourceType === "issue" &&
    externalLink.integrationType === "gitlab" &&
    externalLink.integrationIsActive === true &&
    gitlabOwnsAssignees(externalLink.integrationConfig)
  ) {
    const display = gitlabAssigneeDisplay(
      readGitlabAssignees(externalLink.metadata),
    );
    return {
      ...task[0],
      userId: null,
      assigneeId: null,
      ...display,
    };
  }

  return task[0];
}

export default getTask;
