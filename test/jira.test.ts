import { afterEach, describe, expect, it, vi } from "vitest";
import { linkIssues } from "../src/jira.js";

const opts = {
  baseUrl: "https://example.atlassian.net",
  email: "me@example.com",
  token: "secret",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── linkIssues : sens du lien de blocage ────────────────────────────────────
//
// Régression : sur Jira Cloud, pour le type « Blocks », c'est l'`inwardIssue`
// qui EST le bloqueur (rendu « blocks ») et l'`outwardIssue` qui est le bloqué
// (rendu « is blocked by »). Le mapping ne doit jamais s'inverser.

describe("linkIssues", () => {
  it("envoie le bloqueur en inwardIssue et le bloqué en outwardIssue", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await linkIssues(opts, {
      type: "Blocks",
      blockerKey: "ABC-1",
      blockedKey: "ABC-2",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.atlassian.net/rest/api/3/issueLink");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body);
    expect(body).toEqual({
      type: { name: "Blocks" },
      inwardIssue: { key: "ABC-1" },
      outwardIssue: { key: "ABC-2" },
    });
  });
});
