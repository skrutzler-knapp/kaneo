import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { gitlabSsoMatchesInstance } from "../../../../apps/api/src/plugins/gitlab/utils/gitlab-sso-instance";

const mocks = vi.hoisted(() => ({
  findIntegration: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock(
  "../../../../apps/api/src/gitlab-integration/controllers/reconcile-gitlab-user-assignments",
  () => ({
    reconcileGitlabUserAssignments: mocks.reconcile,
  }),
);

vi.mock("../../../../apps/api/src/database", () => ({
  default: {
    query: {
      integrationTable: {
        findFirst: (...args: unknown[]) => mocks.findIntegration(...args),
      },
    },
  },
}));

const { assertKaneoCanChangeAssignee, isGitlabAssigneeSourceOfTruth } =
  await import("../../../../apps/api/src/plugins/gitlab/utils/assignee-sync");
const { queueGitlabUserAssignments } =
  await import("../../../../apps/api/src/gitlab-integration/controllers/queue-gitlab-user-assignments");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findIntegration.mockResolvedValue({
    isActive: true,
    config: JSON.stringify({ gitlabOwnsAssignees: true }),
  });
});

describe("GitLab assignee ownership", () => {
  it("reports the configured source of truth", async () => {
    await expect(isGitlabAssigneeSourceOfTruth("project-1")).resolves.toBe(
      true,
    );
  });

  it("rejects Kaneo-side assignment changes when GitLab owns assignees", async () => {
    await expect(
      assertKaneoCanChangeAssignee("project-1"),
    ).rejects.toMatchObject({
      status: 409,
      message: "Assignees are managed by the linked GitLab integration",
    });
  });

  it("allows Kaneo assignment changes when no GitLab owner is configured", async () => {
    mocks.findIntegration.mockResolvedValue({
      isActive: true,
      config: JSON.stringify({ gitlabOwnsAssignees: false }),
    });

    await expect(
      assertKaneoCanChangeAssignee("project-1"),
    ).resolves.toBeUndefined();
  });
});

describe("GitLab SSO identity scope", () => {
  it("accepts identity endpoints on the configured GitLab instance", () => {
    expect(
      gitlabSsoMatchesInstance("https://git.example.com/", {
        userInfoUrl: "https://git.example.com/oauth/userinfo",
      }),
    ).toBe(true);
    expect(
      gitlabSsoMatchesInstance("https://example.com/gitlab", {
        discoveryUrl:
          "https://example.com/gitlab/.well-known/openid-configuration",
      }),
    ).toBe(true);
  });

  it("rejects another issuer even if provider IDs are equal", () => {
    for (const userInfoUrl of [
      "https://other.example.com/oauth/userinfo",
      "https://git.example.com.attacker.com/oauth/userinfo",
      "https://git.example.com/gitlab-other/oauth/userinfo",
      "https://user:password@git.example.com/gitlab/oauth/userinfo",
    ]) {
      expect(
        gitlabSsoMatchesInstance("https://git.example.com/gitlab", {
          userInfoUrl,
        }),
      ).toBe(false);
    }
  });

  it("uses discovery as the authoritative issuer when configured", () => {
    expect(
      gitlabSsoMatchesInstance("https://git.example.com", {
        discoveryUrl:
          "https://sso.example.com/.well-known/openid-configuration",
        userInfoUrl: "https://git.example.com/oauth/userinfo",
      }),
    ).toBe(false);
    expect(gitlabSsoMatchesInstance("https://git.example.com", {})).toBe(false);
  });
});

describe("background GitLab assignment reconciliation", () => {
  it("returns immediately and deduplicates concurrent requests for a user", async () => {
    let finish!: () => void;
    const job = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mocks.reconcile.mockReturnValue(job);
    expect(queueGitlabUserAssignments("user-1", "workspace-1")).toBeUndefined();
    queueGitlabUserAssignments("user-1", "workspace-1");
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    finish();
    await job;
    await Promise.resolve();
    await Promise.resolve();
    queueGitlabUserAssignments("user-1", "workspace-1");
    expect(mocks.reconcile).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    await Promise.resolve();
  });

  it("retries a failed reconciliation once without blocking its caller", async () => {
    mocks.reconcile
      .mockRejectedValueOnce(new Error("Transient database failure"))
      .mockResolvedValue(undefined);
    expect(queueGitlabUserAssignments("retry-user")).toBeUndefined();
    await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledTimes(2));
  });

  it("bounds repeated failures and logs context without leaking error details", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.reconcile.mockRejectedValue(
      new Error("secret-bearing error details"),
    );
    queueGitlabUserAssignments("failing-user", "workspace-1");
    await vi.waitFor(() =>
      expect(errorLog).toHaveBeenCalledWith(
        "Background GitLab assignment reconciliation failed",
        {
          userId: "failing-user",
          workspaceId: "workspace-1",
          attempts: 2,
          error: "Error",
        },
      ),
    );
    expect(mocks.reconcile).toHaveBeenCalledTimes(2);
    errorLog.mockRestore();
  });
});
