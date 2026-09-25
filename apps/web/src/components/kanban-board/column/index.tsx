import { cva } from "class-variance-authority";
import { memo, useState } from "react";
import { useBackgroundStore } from "@/store/background";
import type { ProjectWithTasks } from "@/types/project";
import type Task from "@/types/task";
import { ColumnDropzone } from "./column-dropzone";
import { ColumnHeader } from "./column-header";
import { ColumnSortHint } from "./column-sort-hint";

type ColumnProps = {
  column: ProjectWithTasks["columns"][number];
  activeTaskId: string | null;
  sortHint?: string;
  disableDragDrop?: boolean;
  disableSorting?: boolean;
  disableCollectionActions?: boolean;
  columnIndex: number;
  boardRowCount: number;
  rowByTaskId: ReadonlyMap<string, number>;
  subtasksByParentId: ReadonlyMap<string, Task[]>;
  expandedParentIds: ReadonlySet<string>;
  groupSubtasks: boolean;
  onToggleSubtasks: (taskId: string) => void;
};

export const columnVariants = cva(
  "group relative flex h-full min-h-0 w-full flex-col rounded-xl transition-colors duration-150",
  {
    defaultVariants: {
      isDropzoneOver: false,
      backgroundImage: false,
    },
    variants: {
      isDropzoneOver: {
        true: "shadow-md",
        false: "border-border/70 hover:border-border/90",
      },
      backgroundImage: {
        true: "before:content-[''] before:absolute before:inset-0 before:rounded-[calc(var(--radius-xl)-1px)] before:pointer-events-none",
        false: "",
      },
    },
    compoundVariants: [
      {
        isDropzoneOver: false,
        backgroundImage: false,
        class: "border bg-muted/40 shadow-xs/5 dark:bg-card/90",
      },
      {
        isDropzoneOver: true,
        backgroundImage: false,
        class: "border bg-accent/60 border-ring/40 ring-2 ring-ring/30",
      },
      {
        isDropzoneOver: false,
        backgroundImage: true,
        class: "bg-background before:bg-muted before:dark:bg-card shadow-md",
      },
      {
        isDropzoneOver: true,
        backgroundImage: true,
        class: "bg-background ring-2 ring-focus/60 before:bg-accent/60",
      },
    ],
  },
);

function Column({
  column,
  activeTaskId,
  sortHint,
  disableSorting = false,
  disableCollectionActions = false,
  disableDragDrop = false,
  columnIndex,
  boardRowCount,
  rowByTaskId,
  subtasksByParentId,
  expandedParentIds,
  groupSubtasks,
  onToggleSubtasks,
}: ColumnProps) {
  const [isDropzoneOver, setIsDropzoneOver] = useState(false);
  const { background } = useBackgroundStore();

  return (
    <>
      <div
        className={`sticky top-0 z-20 rounded-t-xl border border-b-0 px-3 py-2 ${
          isDropzoneOver
            ? "border-ring/40 bg-accent/80"
            : "border-border/70 bg-background/95 backdrop-blur"
        }`}
        style={{ gridColumn: columnIndex + 1, gridRow: 1 }}
      >
        <ColumnHeader column={column} disableCollectionActions={disableCollectionActions} />
        {sortHint && <ColumnSortHint label={sortHint} />}
      </div>
      <ColumnDropzone
        column={column}
        activeTaskId={activeTaskId}
        disableDragDrop={disableDragDrop}
        disableSorting={disableSorting}
        onIsOverChange={setIsDropzoneOver}
        gridColumn={columnIndex + 1}
        boardRowCount={boardRowCount}
        rowByTaskId={rowByTaskId}
        subtasksByParentId={subtasksByParentId}
        expandedParentIds={expandedParentIds}
        groupSubtasks={groupSubtasks}
        onToggleSubtasks={onToggleSubtasks}
        className={columnVariants({
          isDropzoneOver,
          backgroundImage: !!background,
        })}
      />
    </>
  );
}

export default memo(Column);
