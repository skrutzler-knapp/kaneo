import { reconcileGitlabUserAssignments } from "./reconcile-gitlab-user-assignments";

const pending = new Map<string, Promise<void>>();

export function queueGitlabUserAssignments(
  userId: string,
  workspaceId?: string,
): void {
  const key = JSON.stringify([userId, workspaceId ?? null]);
  if (pending.has(key)) return;
  const job = (async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await reconcileGitlabUserAssignments(userId, workspaceId);
        return;
      } catch (error) {
        if (attempt === 2)
          console.error("Background GitLab assignment reconciliation failed", {
            userId,
            workspaceId,
            attempts: attempt,
            error: error instanceof Error ? error.name : "UnknownError",
          });
      }
    }
  })().finally(() => {
    pending.delete(key);
  });
  pending.set(key, job);
}
