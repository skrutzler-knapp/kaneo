import type { QueryClient } from "@tanstack/react-query";
import type { ProjectTaskRelation } from "@/fetchers/task-relation/get-project-task-relations";

export function updateTaskRelationStatusCaches(
  queryClient: QueryClient,
  taskId: string,
  status: string,
) {
  queryClient.setQueriesData<ProjectTaskRelation[]>(
    { queryKey: ["task-relations"] },
    (relations) =>
      relations?.map((relation) => ({
        ...relation,
        sourceTask:
          relation.sourceTask?.id === taskId
            ? { ...relation.sourceTask, status }
            : relation.sourceTask,
        targetTask:
          relation.targetTask?.id === taskId
            ? { ...relation.targetTask, status }
            : relation.targetTask,
      })),
  );
}