import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import CreateTaskModal from "@/components/shared/modals/create-task-modal";
import TaskCard from "@/components/kanban-board/task-card";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectWithTasks } from "@/types/project";
import type Task from "@/types/task";

type SubtaskExpansionPanelProps = {
  parent: Task;
  subtasks: Task[];
  columns: ProjectWithTasks["columns"];
  row: number;
  anchorColumnIndex: number;
  columnCount: number;
  disableDragDrop?: boolean;
};

function SubtaskLane({
  parentTaskId,
  status,
  name,
  tasks,
  disableDragDrop,
  onAddSubtask,
}: {
  parentTaskId: string;
  status: string;
  name: string;
  tasks: Task[];
  disableDragDrop: boolean;
  onAddSubtask: (status: string) => void;
}) {
  const { t } = useTranslation();
  const { canCreateTasks } = useWorkspacePermission();
  const canCreate = canCreateTasks();
  const { setNodeRef, isOver } = useDroppable({
    id: `subtask-lane:${parentTaskId}:${status}`,
    data: { type: "subtask-lane", parentTaskId, status },
  });
  return (
    <div
      ref={setNodeRef}
      className={`min-w-0 rounded-sm transition-colors ${isOver ? "bg-accent/60 ring-2 ring-ring/30" : ""}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate font-medium">{name}</span>
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium">
            {tasks.length}
          </span>
        </div>
        {canCreate && (
          <button
            type="button"
            onClick={() => onAddSubtask(status)}
            className="flex items-center rounded-md px-2 py-1 text-left text-muted-foreground transition-colors hover:bg-accent/50"
            title={t("tasks:subtasks.addAction")}
            aria-label={t("tasks:subtasks.addAction")}
          >
            <Plus className="h-4 w-4" />
          </button>
        )}
      </div>
      <SortableContext
        items={tasks.map((task) => task.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex min-h-10 flex-col gap-2 p-1">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              disableDragDrop={disableDragDrop}
              dragData={{ type: "subtask", parentTaskId }}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}

export default function SubtaskExpansionPanel({
  parent,
  subtasks,
  columns,
  row,
  anchorColumnIndex,
  columnCount,
  disableDragDrop = false,
}: SubtaskExpansionPanelProps) {
  const { t } = useTranslation();
  const [createStatus, setCreateStatus] = useState<string>();
  const [isCreateTaskOpen, setIsCreateTaskOpen] = useState(false);
  const extraStatuses = [
    ...new Set(subtasks.map((task) => task.status)),
  ].filter((status) => !columns.some((column) => column.slug === status));
  const lanes = [
    ...columns.map((column) => ({ id: column.slug, name: column.name })),
    ...extraStatuses.map((status) => ({ id: status, name: status })),
  ];
  const tasksByStatus = new Map<string, Task[]>();
  for (const task of subtasks) {
    const laneTasks = tasksByStatus.get(task.status) ?? [];
    laneTasks.push(task);
    tasksByStatus.set(task.status, laneTasks);
  }

  return (
    <div
      className="relative z-10 min-w-0 rounded-md border border-border bg-card p-3 shadow-sm"
      style={{ gridColumn: "1 / -1", gridRow: row + 2 }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-2 h-2 border-l-2 border-border"
        style={{ left: `${((anchorColumnIndex + 0.5) / columnCount) * 100}%` }}
      />
      <div className="mb-2 flex items-center gap-2 border-b border-border/70 pb-2">
        <span className="text-xs font-semibold text-muted-foreground">
          {t("tasks:subtasks.title")}
        </span>
        <span className="text-xs text-muted-foreground">{parent.title}</span>
      </div>
      <div
        className="grid items-start gap-3"
        style={{
          gridTemplateColumns: `repeat(${Math.max(lanes.length, 1)}, minmax(0, 1fr))`,
        }}
      >
        {lanes.map((lane) => (
          <SubtaskLane
            key={lane.id}
            parentTaskId={parent.id}
            status={lane.id}
            name={lane.name}
            tasks={tasksByStatus.get(lane.id) ?? []}
            disableDragDrop={disableDragDrop}
            onAddSubtask={(status) => {
              setCreateStatus(status);
              setIsCreateTaskOpen(true);
            }}
          />
        ))}
      </div>
      <CreateTaskModal
        open={isCreateTaskOpen}
        onClose={() => setIsCreateTaskOpen(false)}
        projectId={parent.projectId}
        status={createStatus}
        parentTaskId={parent.id}
      />
    </div>
  );
}
