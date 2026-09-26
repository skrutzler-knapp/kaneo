import { useQuery } from "@tanstack/react-query";
import getProjectTaskRelations from "@/fetchers/task-relation/get-project-task-relations";

function useGetProjectTaskRelations(
  projectId: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["task-relations", "project", projectId],
    queryFn: () => getProjectTaskRelations(projectId),
    enabled: Boolean(projectId) && (options?.enabled ?? true),
  });
}

export default useGetProjectTaskRelations;
