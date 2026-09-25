import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  type SortingStrategy,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect } from "react";
import { cn } from "@/lib/cn";
import type { ProjectWithTasks } from "@/types/project";
import type Task from "@/types/task";
import TaskCard from "../task-card";

const keepOrder: SortingStrategy = () => null;

type ColumnDropzoneProps = {
  column: ProjectWithTasks["columns"][number];
  activeTaskId: string | null;
  disableDragDrop?: boolean;
  disableSorting?: boolean;
  onIsOverChange?: (isOver: boolean) => void;
  className?: string;
  gridColumn: number;
  boardRowCount: number;
  rowByTaskId: ReadonlyMap<string, number>;
  subtasksByParentId: ReadonlyMap<string, Task[]>;
  expandedParentIds: ReadonlySet<string>;
  groupSubtasks: boolean;
  onToggleSubtasks: (taskId: string) => void;
};

export function ColumnDropzone({
  column,
  activeTaskId,
  disableDragDrop = false,
  disableSorting = false,
  onIsOverChange,
  className,
  gridColumn,
  boardRowCount,
  rowByTaskId,
  subtasksByParentId,
  expandedParentIds,
  groupSubtasks,
  onToggleSubtasks,
}: ColumnDropzoneProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, data: { type: "column", column } });
  useEffect(() => { onIsOverChange?.(isOver); }, [isOver, onIsOverChange]);
  const reduceMotion = useReducedMotion();
  const hidden = reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98 };

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "relative min-h-full rounded-xl border p-2 transition-colors duration-150",
        isOver
          ? "border-ring/40 bg-accent/50 ring-2 ring-ring/30"
          : "border-border/70 bg-muted/30 dark:bg-card/60",
        className,
      )}
      style={{
        gridColumn,
        gridRow: `2 / span ${Math.max(boardRowCount, 1)}`,
        display: "grid",
        gridTemplateRows: "subgrid",
        alignContent: "start",
      }}
    >
      <SortableContext
        items={column.tasks}
        strategy={disableSorting ? keepOrder : verticalListSortingStrategy}
      >
        <div className="contents">
          <AnimatePresence initial={false} mode="popLayout">
            {column.tasks.map((task) => (
              <motion.div
                key={task.id}
                className="min-w-0 self-start"
                style={{ gridRow: (rowByTaskId.get(task.id) ?? 0) + 1 }}
                initial={task.id === activeTaskId ? false : hidden}
                animate={
                  reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }
                }
                exit={task.id === activeTaskId ? undefined : hidden}
                transition={{ type: "spring", duration: 0.35, bounce: 0.15 }}
              >
                <TaskCard
                  task={task}
                  disableDragDrop={disableDragDrop}
                  isFinalColumn={column.isFinal}
                  subtaskCount={subtasksByParentId.get(task.id)?.length ?? 0}
                  subtasksExpanded={expandedParentIds.has(task.id)}
                  groupSubtasks={groupSubtasks}
                  onToggleSubtasks={() => onToggleSubtasks(task.id)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </SortableContext>
    </div>
  );
}
