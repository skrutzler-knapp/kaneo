import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  type DropAnimation,
  defaultDropAnimationSideEffects,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { produce } from "immer";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useUpdateTask } from "@/hooks/mutations/task/use-update-task";
import useGetProjectTaskRelations from "@/hooks/queries/task-relation/use-get-project-task-relations";
import { useRegisterShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useProjectBackground } from "@/hooks/use-project-background";
import { cn } from "@/lib/cn";
import { useBackgroundStore } from "@/store/background";
import useBulkSelectionStore from "@/store/bulk-selection";
import useProjectStore from "@/store/project";
import { useUserPreferencesStore } from "@/store/user-preferences";
import type { ProjectWithTasks } from "@/types/project";
import type Task from "@/types/task";
import type { ProjectTaskRelation } from "@/fetchers/task-relation/get-project-task-relations";
import BulkToolbar from "../bulk-selection/bulk-toolbar";
import Column from "./column";
import SubtaskExpansionPanel from "./subtask-expansion-panel";
import TaskCard from "./task-card";

type KanbanBoardProps = {
  project: ProjectWithTasks;
  disableDragDrop?: boolean;
};

function taskFromRelation(
  task: NonNullable<ProjectTaskRelation["targetTask"]>,
): Task {
  return {
    ...task,
    description: null,
    startDate: null,
    dueDate: null,
    position: null,
    createdAt: "",
    assigneeId: task.userId,
  };
}

function KanbanBoard({ project, disableDragDrop = false }: KanbanBoardProps) {
  const queryClient = useQueryClient();
  const { setProject } = useProjectStore();
  const {
    setAvailableTasks,
    focusNext,
    focusPrevious,
    focusedTaskId,
    clearFocus,
  } = useBulkSelectionStore();
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [expandedSubtaskIds, setExpandedSubtaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const { mutate: updateTask } = useUpdateTask();
  const background = useProjectBackground({
    backgroundVersion: project.backgroundVersion,
    projectId: project.id,
    viewMode: "board",
  });
  const backgroundStore = useBackgroundStore();
  const navigate = useNavigate();
  const groupSubtasks = useUserPreferencesStore((state) => state.groupSubtasks);
  const { data: relations = [], isLoading: isLoadingRelations } =
    useGetProjectTaskRelations(project.id);

  const boardState = useMemo(() => {
    const allBoardTasks = project.columns.flatMap((column) => column.tasks);
    const boardTaskById = new Map(allBoardTasks.map((task) => [task.id, task]));
    const taskOrderById = new Map(
      allBoardTasks.map((task, index) => [task.id, index]),
    );
    const childTaskIds = new Set<string>();
    const subtasksByParentId = new Map<string, Task[]>();

    for (const relation of relations) {
      if (
        relation.relationType !== "subtask" ||
        !boardTaskById.has(relation.sourceTaskId) ||
        !relation.targetTask ||
        relation.targetTask.projectId !== project.id
      ) {
        continue;
      }

      const children = subtasksByParentId.get(relation.sourceTaskId) ?? [];
      children.push(
        boardTaskById.get(relation.targetTaskId) ??
          taskFromRelation(relation.targetTask),
      );
      subtasksByParentId.set(relation.sourceTaskId, children);

      if (groupSubtasks && boardTaskById.has(relation.targetTaskId)) {
        childTaskIds.add(relation.targetTaskId);
      }
    }

    for (const children of subtasksByParentId.values()) {
      children.sort(
        (left, right) =>
          (taskOrderById.get(left.id) ?? Number.POSITIVE_INFINITY) -
          (taskOrderById.get(right.id) ?? Number.POSITIVE_INFINITY),
      );
    }

    const columns = project.columns.map((column) => ({
      ...column,
      tasks: column.tasks.filter(
        (task) => !groupSubtasks || !childTaskIds.has(task.id),
      ),
    }));
    const rowByTaskId = new Map<string, number>();
    const expansionRows: Array<{
      parent: Task;
      subtasks: Task[];
      row: number;
      anchorColumnIndex: number;
    }> = [];
    const maxColumnTaskCount = Math.max(
      0,
      ...columns.map((column) => column.tasks.length),
    );
    let row = 0;

    for (let taskIndex = 0; taskIndex < maxColumnTaskCount; taskIndex++) {
      for (const column of columns) {
        const task = column.tasks[taskIndex];
        if (task) rowByTaskId.set(task.id, row);
      }
      row++;

      for (const [anchorColumnIndex, column] of columns.entries()) {
        const parent = column.tasks[taskIndex];
        const subtasks = parent
          ? (subtasksByParentId.get(parent.id) ?? [])
          : [];
        if (
          !groupSubtasks ||
          !parent ||
          !expandedSubtaskIds.has(parent.id) ||
          subtasks.length === 0
        ) {
          continue;
        }

        expansionRows.push({ parent, subtasks, row, anchorColumnIndex });
        row++;
      }
    }

    return {
      columns,
      childTaskIds,
      rowByTaskId,
      subtasksByParentId,
      expansionRows,
      boardRowCount: Math.max(row, 1),
    };
  }, [
    expandedSubtaskIds,
    groupSubtasks,
    project.columns,
    project.id,
    relations,
  ]);

  const toggleSubtasks = useCallback((taskId: string) => {
    setExpandedSubtaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  useEffect(() => {
    backgroundStore.setBackground(background);
  }, [background, backgroundStore.setBackground]);

  useEffect(() => {
    return () => backgroundStore.setBackground(null);
  }, [backgroundStore.setBackground]);

  useEffect(() => {
    if (project?.columns) {
      const allTaskIds = boardState.columns.flatMap((column) =>
        column.tasks.map((task) => task.id),
      );
      setAvailableTasks(allTaskIds);
    }
  }, [boardState.columns, project, setAvailableTasks]);

  useEffect(() => {
    clearFocus();
  }, [clearFocus]);

  useRegisterShortcuts({
    shortcuts: {
      j: () => {
        focusNext();
        const state = useBulkSelectionStore.getState();
        if (state.focusedTaskId) {
          navigate({ to: ".", search: { taskId: state.focusedTaskId } });
        }
      },
      k: () => {
        focusPrevious();
        const state = useBulkSelectionStore.getState();
        if (state.focusedTaskId) {
          navigate({ to: ".", search: { taskId: state.focusedTaskId } });
        }
      },
      Enter: () => {
        if (focusedTaskId && project) {
          navigate({
            to: "/dashboard/workspace/$workspaceId/project/$projectId/task/$taskId",
            params: {
              workspaceId: project.workspaceId,
              projectId: project.id,
              taskId: focusedTaskId,
            },
          });
        }
      },
    },
  });

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: disableDragDrop ? 999999 : 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: disableDragDrop ? 999999 : 250,
        tolerance: 10,
      },
    }),
    useSensor(KeyboardSensor),
  );

  const dropAnimation: DropAnimation = {
    sideEffects: defaultDropAnimationSideEffects({
      styles: {
        active: {
          opacity: "0.8",
        },
      },
    }),
    duration: 300,
    easing: "cubic-bezier(0.23, 1, 0.32, 1)",
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (!over || !project?.columns) return;

    const activeId = active.id.toString();
    const overId = over.id.toString();
    const activeData = active.data.current as
      | { type?: string; parentTaskId?: string }
      | undefined;
    const overData = over.data.current as
      | { type?: string; parentTaskId?: string; status?: string }
      | undefined;

    if (activeData?.type === "subtask") {
      if (disableDragDrop || !activeData.parentTaskId) return;
      if (activeId === overId) return;
      const parentTaskId = activeData.parentTaskId;

      let destinationStatus: string | null = null;
      if (
        overData?.type === "subtask-lane" &&
        overData.parentTaskId === activeData.parentTaskId &&
        typeof overData.status === "string"
      ) {
        destinationStatus = overData.status;
      } else if (
        overData?.type === "subtask" &&
        overData.parentTaskId === activeData.parentTaskId
      ) {
        destinationStatus =
          project.columns
            .flatMap((column) => column.tasks)
            .find((task) => task.id === overId)?.status ?? null;
      }

      if (!destinationStatus) return;

      const sourceColumn = project.columns.find((column) =>
        column.tasks.some((task) => task.id === activeId),
      );
      const destinationColumn = project.columns.find(
        (column) => column.slug === destinationStatus,
      );
      if (!sourceColumn || !destinationColumn) return;

      const updatedProject = produce(project, (draft) => {
        const source = draft.columns.find((column) =>
          column.tasks.some((task) => task.id === activeId),
        );
        const destination = draft.columns.find(
          (column) => column.slug === destinationStatus,
        );
        if (!source || !destination) return;

        const task = source.tasks.find((item) => item.id === activeId);
        if (!task) return;

        const siblingIds = new Set(
          (boardState.subtasksByParentId.get(parentTaskId) ?? []).map(
            (item) => item.id,
          ),
        );

        if (source === destination) {
          const siblings = source.tasks
            .filter((item) => siblingIds.has(item.id))
            .sort(
              (left, right) =>
                (left.position ?? 0) - (right.position ?? 0),
            );
          const sourceIndex = siblings.findIndex(
            (item) => item.id === activeId,
          );
          let destinationIndex =
            overData?.type === "subtask"
              ? siblings.findIndex((item) => item.id === overId)
              : siblings.length;
          if (sourceIndex < 0 || destinationIndex < 0) return;
          if (sourceIndex <= destinationIndex) destinationIndex += 1;

          const reordered = [...siblings];
          const [movedTask] = reordered.splice(sourceIndex, 1);
          if (!movedTask) return;
          reordered.splice(destinationIndex, 0, movedTask);

          const positionSlots = siblings
            .map((item, index) => item.position ?? index)
            .sort((left, right) => left - right);
          reordered.forEach((item, index) => {
            const position = positionSlots[index] ?? index;
            item.position = position;
            updateTask({ ...item, position });
          });
          source.tasks.sort(
            (left, right) =>
              (left.position ?? 0) - (right.position ?? 0),
          );
          return;
        }

        source.tasks = source.tasks.filter((item) => item.id !== activeId);
        task.status = destination.slug;
        const targetIndex = destination.tasks.findIndex(
          (item) => item.id === overId,
        );
        const lastSiblingIndex = destination.tasks.reduce(
          (lastIndex, item, index) =>
            siblingIds.has(item.id) ? index : lastIndex,
          -1,
        );
        const destinationIndex =
          overData?.type === "subtask" && targetIndex >= 0
            ? targetIndex + 1
            : lastSiblingIndex + 1 || destination.tasks.length;
        destination.tasks.splice(destinationIndex, 0, task);

        for (const column of [source, destination]) {
          column.tasks.forEach((item, index) => {
            item.position = index;
            updateTask({ ...item, position: index, status: item.status });
          });
        }
      });

      setProject(updatedProject);
      queryClient.invalidateQueries({
        queryKey: ["projects", project.workspaceId],
      });
      return;
    }

    const updatedProject = produce(project, (draft) => {
      const sourceColumn = draft?.columns?.find((col) =>
        col.tasks.some(
          (task) =>
            task.id === activeId && !boardState.childTaskIds.has(task.id),
        ),
      );
      const destinationColumn = draft?.columns?.find(
        (col) =>
          col.id === overId ||
          col.tasks.some(
            (task) =>
              task.id === overId && !boardState.childTaskIds.has(task.id),
          ),
      );

      if (!sourceColumn || !destinationColumn) return;

      const sourceChildren = sourceColumn.tasks.filter((task) =>
        boardState.childTaskIds.has(task.id),
      );
      const sourceTasks = sourceColumn.tasks.filter(
        (task) => !boardState.childTaskIds.has(task.id),
      );
      const destinationChildren =
        sourceColumn === destinationColumn
          ? sourceChildren
          : destinationColumn.tasks.filter((task) =>
              boardState.childTaskIds.has(task.id),
            );
      const destinationTasks =
        sourceColumn === destinationColumn
          ? sourceTasks
          : destinationColumn.tasks.filter(
              (task) => !boardState.childTaskIds.has(task.id),
            );

      const sourceTaskIndex = sourceTasks.findIndex(
        (task) => task.id === activeId,
      );
      const task = sourceTasks[sourceTaskIndex];

      const reorderedSourceTasks = sourceTasks.filter((t) => t.id !== activeId);

      if (sourceColumn.id === destinationColumn.id) {
        let destinationIndex = destinationTasks.findIndex(
          (t) => t.id === overId,
        );
        if (sourceTaskIndex <= destinationIndex) {
          destinationIndex += 1;
        }
        reorderedSourceTasks.splice(destinationIndex, 0, task);
        sourceColumn.tasks = [...reorderedSourceTasks, ...sourceChildren];

        reorderedSourceTasks.forEach((t, index) => {
          updateTask({ ...t, position: index });
        });

        queryClient.invalidateQueries({
          queryKey: ["projects", project.workspaceId],
        });
      } else {
        // A task's status is a column slug. The column id is only the
        // droppable identity here, and the two are interchangeable only
        // because the tasks endpoint happens to return `id: column.slug`.
        task.status = destinationColumn.slug;
        const destinationIndex =
          overId === destinationColumn.id
            ? destinationTasks.length
            : destinationTasks.findIndex((t) => t.id === overId) + 1;

        destinationTasks.splice(destinationIndex, 0, task);
        sourceColumn.tasks = [...reorderedSourceTasks, ...sourceChildren];
        destinationColumn.tasks = [...destinationTasks, ...destinationChildren];

        destinationTasks.forEach((t, index) => {
          updateTask({ ...t, status: destinationColumn.slug, position: index });
        });

        reorderedSourceTasks.forEach((t, index) => {
          updateTask({ ...t, position: index });
        });
      }
    });

    setProject(updatedProject);
    setActiveId(null);
  };

  if (!project?.columns || isLoadingRelations) {
    return (
      <div className="flex h-full w-full flex-col bg-linear-to-b from-muted/25 to-background">
        <header className="mb-6 mt-6 space-y-6 shrink-0 px-6">
          <div className="flex items-center justify-between">
            <div className="w-48 h-8 bg-muted/50 rounded-md animate-pulse" />
          </div>
        </header>

        <div className="relative min-h-0 flex-1">
          <div className="flex h-full flex-1 gap-4 overflow-x-auto px-4 pb-4 md:px-5">
            {[...Array(4)].map((_, i) => (
              <div
                key={`kanban-column-skeleton-${
                  // biome-ignore lint/suspicious/noArrayIndexKey: It's a skeleton
                  i
                }`}
                className="h-full min-w-80 w-full flex-1 rounded-xl border border-border/70 bg-card"
              >
                <div className="px-4 py-3 flex items-center justify-between">
                  <div className="w-24 h-5 bg-muted/50 rounded animate-pulse" />
                  <div className="w-8 h-5 bg-muted/50 rounded animate-pulse" />
                </div>

                <div className="px-2 pb-4 flex flex-col gap-3 flex-1">
                  {[...Array(3)].map((_, j) => (
                    <div
                      key={`kanban-task-skeleton-${
                        // biome-ignore lint/suspicious/noArrayIndexKey: It's a skeleton
                        j
                      }`}
                      className="p-4 bg-card rounded-lg border border-border/50 animate-pulse"
                    >
                      <div className="space-y-3">
                        <div className="w-2/3 h-4 bg-muted/70 rounded" />
                        <div className="w-1/2 h-3 bg-muted/70 rounded" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const activeTask = activeId
    ? project.columns
        .flatMap((col) => col.tasks)
        .find((task) => task.id === activeId)
    : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div
        className={cn("flex h-full w-full flex-col", {
          "bg-linear-to-b from-muted/20 to-background": !background,
        })}
      >
        <div className="min-h-0 flex-1 overflow-auto [-webkit-overflow-scrolling:touch]">
          <div
            className="grid min-w-max items-start gap-x-4 gap-y-2 px-4 py-4 md:px-5"
            style={{
              gridTemplateColumns: `repeat(${boardState.columns.length}, minmax(20rem, 24rem))`,
              gridTemplateRows: `auto repeat(${boardState.boardRowCount}, minmax(0, max-content))`,
            }}
          >
            {boardState.columns.map((column, columnIndex) => (
              <Column
                key={column.id}
                column={column}
                columnIndex={columnIndex}
                boardRowCount={boardState.boardRowCount}
                rowByTaskId={boardState.rowByTaskId}
                subtasksByParentId={boardState.subtasksByParentId}
                expandedParentIds={expandedSubtaskIds}
                groupSubtasks={groupSubtasks}
                onToggleSubtasks={toggleSubtasks}
                disableDragDrop={disableDragDrop}
              />
            ))}
            {boardState.expansionRows.map((expansion) => (
              <SubtaskExpansionPanel
                key={expansion.parent.id}
                {...expansion}
                columns={boardState.columns}
                columnCount={boardState.columns.length}
                disableDragDrop={disableDragDrop}
              />
            ))}
          </div>
        </div>
      </div>
      <DragOverlay dropAnimation={dropAnimation}>
        {activeTask ? (
          <div className="transform rotate-1 scale-[1.03] shadow-lg">
            <div className="ring-2 ring-ring/35 rounded-lg">
              <TaskCard task={activeTask} />
            </div>
          </div>
        ) : null}
      </DragOverlay>

      <BulkToolbar />
    </DndContext>
  );
}

export default KanbanBoard;
