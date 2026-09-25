import useGetGitlabIntegration from "@/hooks/queries/gitlab-integration/use-get-gitlab-integration";

export default function useGitlabAssigneeOwnership(projectId: string) {
  const { data: integration } = useGetGitlabIntegration(projectId);
  return integration?.gitlabOwnsAssignees === true;
}
