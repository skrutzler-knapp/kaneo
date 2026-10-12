import { and, eq, inArray } from "drizzle-orm";
import db from "../../../database";
import {
  accountTable,
  gitlabUserIdentityTable,
  projectTable,
  userTable,
  workspaceUserTable,
} from "../../../database/schema";
import { projectAccessCondition } from "../../../project-access/project-access-condition";
import type { IntegrationDatabase } from "../../github/services/integration-task-scope";
import { normalizeGitlabBaseUrl, type GitlabConfig } from "../config";
import type { GitlabAssigneeSnapshot } from "./assignee-sync";
import { createGitlabClient, type GitlabUser } from "./gitlab-api";
import { gitlabSsoMatchesInstance } from "./gitlab-sso-instance";

export function createGitlabAssigneeResolver(
  config: GitlabConfig,
  projectId: string,
) {
  const baseUrl = normalizeGitlabBaseUrl(config.baseUrl);
  const profiles = new Map<string, Promise<GitlabUser | null>>();

  return async (
    assignees: GitlabAssigneeSnapshot[],
    database: IntegrationDatabase = db,
  ): Promise<string | null> => {
    if (!assignees.length) return null;
    const eligible = await database
      .select({
        id: userTable.id,
        email: userTable.email,
        emailVerified: userTable.emailVerified,
      })
      .from(userTable)
      .innerJoin(
        workspaceUserTable,
        eq(workspaceUserTable.userId, userTable.id),
      )
      .innerJoin(
        projectTable,
        eq(projectTable.workspaceId, workspaceUserTable.workspaceId),
      )
      .where(
        and(
          eq(projectTable.id, projectId),
          eq(userTable.banned, false),
          eq(userTable.isAnonymous, false),
          projectAccessCondition(userTable.id, projectTable.id),
        ),
      );
    if (!eligible.length) return null;
    const users = new Map(eligible.map((user) => [user.id, user]));
    const ids = assignees.map((assignee) => assignee.id);
    const identities = await database
      .select()
      .from(gitlabUserIdentityTable)
      .where(
        and(
          eq(gitlabUserIdentityTable.baseUrl, baseUrl),
          inArray(gitlabUserIdentityTable.gitlabUserId, ids),
        ),
      );
    const accounts = gitlabSsoMatchesInstance(baseUrl)
      ? await database
          .select({
            userId: accountTable.userId,
            accountId: accountTable.accountId,
          })
          .from(accountTable)
          .where(
            and(
              eq(accountTable.providerId, "custom"),
              inArray(accountTable.accountId, ids),
            ),
          )
      : [];

    for (const assignee of assignees) {
      const existing = identities.find(
        (identity) => identity.gitlabUserId === assignee.id,
      );
      if (existing) {
        if (users.has(existing.userId)) return existing.userId;
        continue;
      }
      const linkedAccounts = accounts.filter(
        (account) => account.accountId === assignee.id,
      );
      let userId =
        linkedAccounts.length === 1 && users.has(linkedAccounts[0]!.userId)
          ? linkedAccounts[0]!.userId
          : null;
      if (!userId && !linkedAccounts.length && /^\d+$/.test(assignee.id)) {
        if (!profiles.has(assignee.id)) {
          profiles.set(
            assignee.id,
            createGitlabClient(config)
              .getUser(assignee.id)
              .catch(() => null),
          );
        }
        const profile = await profiles.get(assignee.id);
        const email =
          profile && String(profile.id) === assignee.id
            ? (
                profile.public_email ||
                (profile.confirmed_at ? profile.email : null)
              )
                ?.trim()
                .toLowerCase()
            : null;
        if (email) {
          const matches = eligible.filter(
            (user) =>
              user.emailVerified && user.email.trim().toLowerCase() === email,
          );
          if (matches.length === 1) userId = matches[0]!.id;
        }
      }
      if (!userId) continue;
      await database
        .insert(gitlabUserIdentityTable)
        .values({ baseUrl, gitlabUserId: assignee.id, userId })
        .onConflictDoNothing({
          target: [
            gitlabUserIdentityTable.baseUrl,
            gitlabUserIdentityTable.gitlabUserId,
          ],
        });
      const [identity] = await database
        .select({ userId: gitlabUserIdentityTable.userId })
        .from(gitlabUserIdentityTable)
        .where(
          and(
            eq(gitlabUserIdentityTable.baseUrl, baseUrl),
            eq(gitlabUserIdentityTable.gitlabUserId, assignee.id),
          ),
        )
        .limit(1);
      if (identity && users.has(identity.userId)) return identity.userId;
    }
    return null;
  };
}
