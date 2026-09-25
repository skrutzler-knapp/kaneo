import { useMutation, useQueryClient } from "@tanstack/react-query";
import updateTask from "@/fetchers/task/update-task";
import { updateTaskRelationStatusCaches } from "@/lib/task-relation-cache";
import type Task from "@/types/task";

export function useUpdateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (task: Task) => updateTask(task.id, task),
    onSuccess: (_, variables) => {
      updateTaskRelationStatusCaches(
        queryClient,
        variables.id,
        variables.status,
      );
      queryClient.invalidateQueries({
        queryKey: ["task", variables.id],
      });
      queryClient.invalidateQueries({
        queryKey: ["tasks", variables.projectId],
      });
      queryClient.invalidateQueries({
        queryKey: ["notifications"],
      });
      queryClient.invalidateQueries({
        queryKey: ["projects"],
      });
      queryClient.invalidateQueries({
        queryKey: ["activities", variables.id],
      });
    },
  });
}
