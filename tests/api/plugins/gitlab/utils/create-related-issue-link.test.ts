import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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

const { createRelatedIssueLink, deleteRelatedIssueLink } =
  await import("../../../../../apps/api/src/plugins/gitlab/utils/create-related-issue-link");

const config = {
  baseUrl: "https://gitlab.example.com",
  accessToken: "test-token",
  tokenType: "private" as const,
  projectPath: "acme/web",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("createRelatedIssueLink", () => {
  it("creates a related-issue link only when one does not already exist", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 123,
            name: "web",
            path_with_namespace: "acme/web",
            name_with_namespace: "acme/web",
            visibility: "private",
            web_url: "https://gitlab.example.com/acme/web",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));

    await createRelatedIssueLink(config, 1, 8);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[2][0]).toContain("/issues/1/links");
    expect(mockFetch.mock.calls[2][1].method).toBe("POST");
    expect(JSON.parse(mockFetch.mock.calls[2][1].body as string)).toEqual({
      target_project_id: 123,
      target_issue_iid: 8,
      link_type: "relates_to",
    });
  });

  it("does not create a duplicate related-issue link", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 123,
            name: "web",
            path_with_namespace: "acme/web",
            name_with_namespace: "acme/web",
            visibility: "private",
            web_url: "https://gitlab.example.com/acme/web",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              link_type: "relates_to",
              iid: 8,
              project_id: 123,
            },
          ]),
          { status: 200 },
        ),
      );

    await createRelatedIssueLink(config, 1, 8);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("deletes a provider issue link by its relation ID", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              issue_link_id: 19,
              iid: 8,
              project_id: 123,
              link_type: "relates_to",
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await deleteRelatedIssueLink(config, 1, 8, "relates_to");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toContain(
      "/issues/1/links/19?link_type=relates_to",
    );
    expect(mockFetch.mock.calls[1][1].method).toBe("DELETE");
  });
});
