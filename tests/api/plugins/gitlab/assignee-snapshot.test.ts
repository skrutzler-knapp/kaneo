import { describe, expect, it } from "vite-plus/test";
import {
  gitlabAssigneeDisplay,
  gitlabOwnsAssignees,
  mergeGitlabAssigneesMetadata,
  readGitlabAssignees,
  snapshotGitlabAssignees,
} from "../../../../apps/api/src/plugins/gitlab/utils/assignee-sync";

describe("GitLab assignee snapshots", () => {
  it("keeps provider identity without requiring a Kaneo user match", () => {
    expect(
      snapshotGitlabAssignees([
        {
          id: 42,
          username: "ada",
          name: "Ada Lovelace",
          avatar_url: "https://gitlab.example/ada.png",
        },
      ]),
    ).toEqual([
      {
        id: "42",
        username: "ada",
        name: "Ada Lovelace",
        avatarUrl: "https://gitlab.example/ada.png",
      },
    ]);
  });

  it("preserves other metadata and produces provider display values", () => {
    const metadata = mergeGitlabAssigneesMetadata(
      JSON.stringify({ state: "opened", author: "gitlab-user" }),
      snapshotGitlabAssignees([
        { id: 7, username: "grace", name: "Grace Hopper" },
        { id: 8, username: "ada", name: "Ada Lovelace" },
      ]),
    );

    expect(metadata.state).toBe("opened");
    expect(
      gitlabAssigneeDisplay(readGitlabAssignees(JSON.stringify(metadata))),
    ).toEqual({
      assigneeName: "Grace Hopper, Ada Lovelace",
      assigneeUsername: "@grace, @ada",
      assigneeImage: null,
    });
  });

  it("represents an explicit GitLab unassignment as an empty snapshot", () => {
    expect(snapshotGitlabAssignees([])).toEqual([]);
  });

  it("recognizes GitLab as the assignee source of truth", () => {
    expect(gitlabOwnsAssignees('{"gitlabOwnsAssignees":true}')).toBe(true);
    expect(gitlabOwnsAssignees('{"gitlabOwnsAssignees":false}')).toBe(false);
  });
});
