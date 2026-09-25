import { and, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  customFieldDefinitionTable,
  customFieldValueTable,
  labelTable,
  taskRelationTable,
  taskTable,
  userTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import {
  assertAssignableUser,
  getProjectWorkspaceId,
} from "../../utils/assert-assignable-user";
import {
  assertRequiredCustomFields,
  assertValidTaskStatus,
  isCustomFieldValueEmpty,
} from "../validate-task-fields";
import { claimTaskNumber } from "./claim-task-numbers";
import { nextTaskPosition } from "./next-task-position";

type CustomFieldInput = {
  fieldId: string;
  value: string;
};

function deduplicateCustomFields(
  customFields?: CustomFieldInput[],
): CustomFieldInput[] | undefined {
  if (!customFields) {
    return undefined;
  }

  const fieldsById = new Map<string, CustomFieldInput>();

  for (const customField of customFields) {
    fieldsById.set(customField.fieldId, customField);
  }

  return Array.from(fieldsById.values());
}

async function createTask({
  projectId,
  currentUserId,
  userId,
  title,
  status,
  startDate,
  dueDate,
  description,
  priority,
  customFields,
  parentTaskId,
  labelIds,
}: {
  projectId: string;
  currentUserId: string;
  userId?: string;
  title: string;
  status: string;
  startDate?: Date;
  dueDate?: Date;
  description?: string;
  priority?: string;
  customFields?: CustomFieldInput[];
  parentTaskId?: string;
  labelIds?: string[];
}) {
  const resolvedStatus = status || "to-do";
  const resolvedPriority = priority || "no-priority";
  const normalizedCustomFields = deduplicateCustomFields(customFields);
  const normalizedLabelIds = [...new Set(labelIds ?? [])];

  const normalizedUserId = userId?.trim() || undefined;

  await assertValidTaskStatus(resolvedStatus, projectId);
  const workspaceId = normalizedLabelIds.length
    ? await getProjectWorkspaceId(projectId)
    : undefined;

  const allFields = await db
    .select()
    .from(customFieldDefinitionTable)
    .where(eq(customFieldDefinitionTable.projectId, projectId));

  const mergedCustomFields: CustomFieldInput[] = normalizedCustomFields ?? [];
  const providedFieldIds = new Set(mergedCustomFields.map((f) => f.fieldId));

  for (const field of allFields) {
    if (
      !providedFieldIds.has(field.id) &&
      field.required &&
      field.defaultValue != null &&
      !isCustomFieldValueEmpty(
        field.defaultValue,
        field.type as
          | "number"
          | "boolean"
          | "date"
          | "dropdown"
          | "multiselect",
      )
    ) {
      mergedCustomFields.push({
        fieldId: field.id,
        value: field.defaultValue,
      });
    }
  }

  await assertRequiredCustomFields(projectId, mergedCustomFields);

  let assignee: { name: string } | undefined;

  if (normalizedUserId) {
    await assertAssignableUser(
      normalizedUserId,
      await getProjectWorkspaceId(projectId),
    );

    [assignee] = await db
      .select({ name: userTable.name })
      .from(userTable)
      .where(eq(userTable.id, normalizedUserId));
  }

  const column = await db.query.columnTable.findFirst({
    where: and(
      eq(columnTable.projectId, projectId),
      eq(columnTable.slug, resolvedStatus),
    ),
  });

  const result = await db.transaction(async (tx) => {
    const selectedLabels =
      workspaceId && normalizedLabelIds.length > 0
        ? await tx.query.labelTable.findMany({
            where: and(
              inArray(labelTable.id, normalizedLabelIds),
              eq(labelTable.workspaceId, workspaceId),
            ),
          })
        : [];

    if (selectedLabels.length !== normalizedLabelIds.length) {
      throw new HTTPException(404, { message: "Workspace label not found" });
    }
    if (selectedLabels.some((label) => label.deletionStartedAt)) {
      throw new HTTPException(409, {
        message: "A selected label is being deleted",
      });
    }

    if (parentTaskId) {
      const [parentTask] = await tx
        .select({ id: taskTable.id })
        .from(taskTable)
        .where(
          and(
            eq(taskTable.id, parentTaskId),
            eq(taskTable.projectId, projectId),
          ),
        )
        .limit(1);

      if (!parentTask) {
        throw new HTTPException(404, {
          message: "Parent task not found in project",
        });
      }
    }

    const taskNumber = await claimTaskNumber(projectId, tx);
    const nextPosition = await nextTaskPosition(
      tx,
      projectId,
      resolvedStatus,
      column?.id ?? null,
    );

    const [task] = await tx
      .insert(taskTable)
      .values({
        projectId,
        userId: normalizedUserId ?? null,
        title: title || "",
        status: resolvedStatus,
        columnId: column?.id ?? null,
        startDate: startDate || null,
        dueDate: dueDate || null,
        description: description || "",
        priority: resolvedPriority,
        number: taskNumber,
        position: nextPosition,
      })
      .returning();

    if (task && mergedCustomFields.length) {
      await tx.insert(customFieldValueTable).values(
        mergedCustomFields.map(({ fieldId, value }) => ({
          taskId: task.id,
          fieldId,
          value: value.trim(),
        })),
      );
    }

    const taskLabels =
      task && selectedLabels.length > 0
        ? await tx
            .insert(labelTable)
            .values(
              selectedLabels.map((label) => ({
                name: label.name,
                color: label.color,
                taskId: task.id,
                workspaceId,
              })),
            )
            .onConflictDoNothing({
              target: [labelTable.taskId, labelTable.name],
            })
            .returning()
        : [];

    let relation: typeof taskRelationTable.$inferSelect | undefined;
    if (task && parentTaskId) {
      [relation] = await tx
        .insert(taskRelationTable)
        .values({
          sourceTaskId: parentTaskId,
          targetTaskId: task.id,
          relationType: "subtask",
        })
        .returning();
    }

    return { task, relation, taskLabels };
  });

  const createdTask = result.task;
  if (!createdTask) {
    throw new HTTPException(500, {
      message: "Failed to create task",
    });
  }

  if (result.relation) {
    await publishEvent("task-relation.created", {
      ...result.relation,
      taskId: createdTask.id,
      projectId,
      userId: currentUserId,
      source: "kaneo",
    });
  }

  for (const label of result.taskLabels) {
    await publishEvent("task.label_created", {
      label,
      taskId: createdTask.id,
      projectId,
      userId: currentUserId,
      type: "label_created",
    });
  }

  await publishEvent("task.created", {
    ...createdTask,
    taskId: createdTask.id,
    userId: createdTask.userId ?? "",
    currentUserId: currentUserId,
    type: "created",
    content: null,
  });

  return {
    ...createdTask,
    assigneeName: assignee?.name,
  };
}

export default createTask;
