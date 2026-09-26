import { ChevronDown, ChevronUp, ListTree, SquareCheck } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { getTaskItemStats } from "@/lib/get-task-item-stats";
import { useUserPreferencesStore } from "@/store/user-preferences";
import type Task from "@/types/task";

export function TaskProgressBadges({
  task,
  asText = false,
  subtaskToggle,
}: {
  task: Pick<Task, "description" | "descriptionDeferred" | "subtaskCounts">;
  asText?: boolean;
  subtaskToggle?: { expanded: boolean; onToggle: () => void };
}) {
  const { t } = useTranslation();
  const { showTaskItemCounts } = useUserPreferencesStore();
  const checklist = useMemo(
    () =>
      showTaskItemCounts && !task.descriptionDeferred
        ? getTaskItemStats(task.description)
        : null,
    [task.description, task.descriptionDeferred, showTaskItemCounts],
  );
  const counters = [
    {
      kind: "subtasks",
      counts: task.subtaskCounts,
      Icon: ListTree,
      label: t("tasks:subtasks.progress", {
        completed: task.subtaskCounts?.completed ?? 0,
        total: task.subtaskCounts?.total ?? 0,
      }),
    },
    {
      kind: "checklist",
      counts: showTaskItemCounts ? checklist : undefined,
      Icon: SquareCheck,
      label: t("tasks:checklistProgress", {
        completed: checklist?.completed ?? 0,
        total: checklist?.total ?? 0,
      }),
    },
  ];

  return counters.map(({ kind, counts, Icon, label }) => {
    if (!counts || counts.total === 0) return null;
    const className = cn(
      "inline-flex h-5.5 shrink-0 cursor-inherit items-center gap-1 rounded border border-border/70 bg-muted/50 px-2 py-1 text-[10px] font-medium tabular-nums text-muted-foreground",
      counts.completed === counts.total &&
        "border-success/20 bg-success/10 text-success-foreground",
    );
    const content = (
      <>
        <Icon className="size-3" aria-hidden="true" />
        {counts.completed}/{counts.total}
      </>
    );

    // Public cards are buttons already; their badges must remain plain text.
    if (asText) {
      return (
        <span key={kind} className={className} title={label}>
          <span className="sr-only">{label}</span>
          <span aria-hidden="true" className="inline-flex items-center gap-1">
            {content}
          </span>
        </span>
      );
    }

    if (kind === "subtasks" && subtaskToggle) {
      const actionLabel = t(
        subtaskToggle.expanded
          ? "tasks:subtasks.collapseAction"
          : "tasks:subtasks.expandAction",
      );
      const Chevron = subtaskToggle.expanded ? ChevronUp : ChevronDown;
      return (
        <Tooltip key={kind}>
          <TooltipTrigger
            aria-label={`${actionLabel}, ${label}`}
            aria-expanded={subtaskToggle.expanded}
            className={cn(
              className,
              "relative cursor-pointer transition-colors after:absolute after:-inset-1.5 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            // The card is a drag handle and opens on click/Enter.
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              subtaskToggle.onToggle();
            }}
          >
            {content}
            <Chevron className="size-3" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>{label}</TooltipPopup>
        </Tooltip>
      );
    }

    return (
      <Tooltip key={kind}>
        <TooltipTrigger aria-label={label} className={className}>
          {content}
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
    );
  });
}
