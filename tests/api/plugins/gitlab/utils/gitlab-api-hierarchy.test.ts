import { afterEach, describe, expect, it, vi } from "vitest";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock("../../../../../apps/api/src/utils/assert-public-destination", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../../apps/api/src/utils/assert-public-destination")
  >("../../../../../apps/api/src/utils/assert-public-destination");
  return { ...actual, assertPublicDestination: vi.fn() };
});

vi.stubGlobal("fetch", mockFetch);

const { createGitlabClient } = await import(
  "../../../../../apps/api/src/plugins/gitlab/utils/gitlab-api"
);

const client = () =>
  createGitlabClient({
    baseUrl: "https://gitlab.example.com",
    accessToken: "test-token",
    tokenType: "private",
  });

function workItemIdsResponse(childIid = "4") {
  return new Response(
    JSON.stringify({
      data: {
        project: {
          workItems: {
            nodes: [
              { id: "parent-global-id", iid: "1" },
              { id: "child-global-id", iid: childIid },
            ],
          },
        },
      },
    }),
    { status: 200 },
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GitLab work item hierarchy", () => {
  it("sets the child work item's parent using the hierarchy mutation", async () => {
    mockFetch
      .mockResolvedValueOnce(workItemIdsResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              workItemsHierarchyReorder: {
                errors: [],
                workItem: { iid: "4" },
                parentWorkItem: { iid: "1" },
              },
            },
          }),
          { status: 200 },
        ),
      );

    await client().setSubtaskParent("acme/web", 1, 4);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const mutationRequest = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(mutationRequest.query).toContain("workItemsHierarchyReorder");
    expect(mutationRequest.variables).toEqual({
      parentId: "parent-global-id",
      childId: "child-global-id",
    });
  });

});
