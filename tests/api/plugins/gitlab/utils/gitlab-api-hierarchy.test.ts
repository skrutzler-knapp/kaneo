import { afterEach, describe, expect, it, vi } from "vitest";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock(
  "../../../../../apps/api/src/utils/assert-public-destination",
  async () => {
    const actual = await vi.importActual<
      typeof import("../../../../../apps/api/src/utils/assert-public-destination")
    >("../../../../../apps/api/src/utils/assert-public-destination");
    return { ...actual, assertPublicDestination: vi.fn() };
  },
);

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
    const mutationRequest = JSON.parse(
      mockFetch.mock.calls[1][1].body as string,
    );
    expect(mutationRequest.query).toContain("workItemsHierarchyReorder");
    expect(mutationRequest.variables).toEqual({
      parentId: "parent-global-id",
      childId: "child-global-id",
    });
  });

  it("lists related issue links and deletes them with their link type", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              issue_link_id: 19,
              iid: 3,
              project_id: 42,
              link_type: "relates_to",
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const gitlab = client();
    await expect(gitlab.listIssueLinks("acme/web", 5)).resolves.toEqual([
      {
        issue_link_id: 19,
        iid: 3,
        project_id: 42,
        link_type: "relates_to",
      },
    ]);
    await gitlab.deleteIssueLink("acme/web", 5, 19, "relates_to");

    expect(mockFetch.mock.calls[0][0]).toContain(
      "/api/v4/projects/acme%2Fweb/issues/5/links",
    );
    expect(mockFetch.mock.calls[1][0]).toContain(
      "/api/v4/projects/acme%2Fweb/issues/5/links/19?link_type=relates_to",
    );
    expect(mockFetch.mock.calls[1][1].method).toBe("DELETE");
  });

  it("removes a child work item's parent with a null parent ID", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              project: {
                workItems: {
                  nodes: [{ id: "child-global-id", iid: "4" }],
                },
              },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              workItemsHierarchyReorder: {
                errors: [],
                workItem: { iid: "4" },
                parentWorkItem: null,
              },
            },
          }),
          { status: 200 },
        ),
      );

    await client().removeSubtaskParent("acme/web", 4);

    const mutationRequest = JSON.parse(
      mockFetch.mock.calls[1][1].body as string,
    );
    expect(mutationRequest.variables).toEqual({
      parentId: null,
      childId: "child-global-id",
    });
  });
});
