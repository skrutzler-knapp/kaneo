import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import db from "../../database";
import {
  externalLinkTable,
  integrationTable,
  projectTable,
  taskRelationTable,
  taskTable,
  userTable,
} from "../../database/schema";
import { projectAccessCondition } from "../../project-access/project-access-condition";
import {
  gitlabAssigneeDisplay,
  gitlabOwnsAssignees,
  readGitlabAssignees,
} from "../../plugins/gitlab/utils/assignee-sync";
import { taskIsCompleted } from "../../task/task-is-completed";

async function getTaskRelations(
  taskId: string,
  workspaceId: string,
  userId: string,
) {
  return getRelationsForTaskIds([taskId], workspaceId, userId);
}

async function getProjectTaskRelations(projectId: string, workspaceId: string, userId: string) {
  const projectTaskIds = () =>
    db
      .select({ id: taskTable.id })
      .from(taskTable)
      .where(eq(taskTable.projectId, projectId));

  return getRelationsForTaskScope(
    or(
      inArray(taskRelationTable.sourceTaskId, projectTaskIds()),
      inArray(taskRelationTable.targetTaskId, projectTaskIds()),
    ),
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

  return getRelationsForTaskScope(
    or(
      inArray(taskRelationTable.sourceTaskId, taskIdsInScope),
      inArray(taskRelationTable.targetTaskId, taskIdsInScope),
    ),
    workspaceId,
    userId,
  );
}

async function getRelationsForTaskScope(
  relationScope: SQL | undefined,
  workspaceId: string,
  userId: string,
) {
  const relations = await db
    .select({
      id: taskRelationTable.id,
      sourceTaskId: taskRelationTable.sourceTaskId,
      targetTaskId: taskRelationTable.targetTaskId,
      relationType: taskRelationTable.relationType,
      createdAt: taskRelationTable.createdAt,
    })
    .from(taskRelationTable)
    .where(relationScope);

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
      assigneeImage: string | null;
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
        assigneeImage: userTable.image,
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

    const externalLinks = await db
      .select({
        taskId: externalLinkTable.taskId,
        integrationId: externalLinkTable.integrationId,
        metadata: externalLinkTable.metadata,
        integrationConfig: integrationTable.config,
      })
      .from(externalLinkTable)
      .innerJoin(
        integrationTable,
        eq(externalLinkTable.integrationId, integrationTable.id),
      )
      .where(
        and(
          inArray(externalLinkTable.taskId, [...taskIds]),
          eq(externalLinkTable.resourceType, "issue"),
          eq(integrationTable.type, "gitlab"),
          eq(integrationTable.isActive, true),
        ),
      );

    const gitlabOwnershipByIntegrationId = new Map<string, boolean>();
    for (const externalLink of externalLinks) {
      if (!externalLink.integrationId) continue;
      let ownsAssignees = gitlabOwnershipByIntegrationId.get(
        externalLink.integrationId,
      );
      if (ownsAssignees === undefined) {
        ownsAssignees = gitlabOwnsAssignees(externalLink.integrationConfig);
        gitlabOwnershipByIntegrationId.set(
          externalLink.integrationId,
          ownsAssignees,
        );
      }
      if (!ownsAssignees) continue;
      const task = tasks.get(externalLink.taskId);
      if (!task) continue;
      tasks.set(externalLink.taskId, {
        ...task,
        userId: null,
        ...gitlabAssigneeDisplay(readGitlabAssignees(externalLink.metadata)),
      });
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
