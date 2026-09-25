import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findIntegration: vi.fn(),
}));

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
