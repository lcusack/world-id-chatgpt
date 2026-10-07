import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchOfficialWorldIdBenefits,
  WorldIdBenefitCatalogError,
} from "../worker/world-id-benefit-catalog.ts";

function response(benefits: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: "world-id-benefits",
    result: { structuredContent: { benefits } },
  });
}

test("calls the official no-auth MCP benefit tool and validates its structured result", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const benefits = await fetchOfficialWorldIdBenefits((async (input, init) => {
    seen.url = String(input);
    seen.init = init;
    return response([
      { name: "Maitre", description: "Restaurant reservations for humans", appUrl: "https://maitre.fun#offer" },
      { name: "Duplicate", description: "Duplicate URL", appUrl: "https://maitre.fun/" },
    ]);
  }) as typeof fetch);

  assert.equal(seen.url, "https://auth.world.org/mcp");
  assert.equal(seen.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(seen.init?.body)), {
    jsonrpc: "2.0",
    id: "world-id-benefits",
    method: "tools/call",
    params: { name: "get_benefits", arguments: {} },
  });
  assert.deepEqual(benefits, [{
    name: "Duplicate",
    description: "Duplicate URL",
    appUrl: "https://maitre.fun/",
  }]);
});

test("rejects malformed or unsafe official catalog listings", async () => {
  await assert.rejects(
    fetchOfficialWorldIdBenefits((async () => response([
      { name: "Unsafe", description: "Bad URL", appUrl: "http://example.com" },
    ])) as typeof fetch),
    (error: unknown) => error instanceof WorldIdBenefitCatalogError && error.code === "malformed",
  );
});

test("reports upstream HTTP failures distinctly", async () => {
  await assert.rejects(
    fetchOfficialWorldIdBenefits((async () => new Response("unavailable", { status: 503 })) as typeof fetch),
    (error: unknown) => error instanceof WorldIdBenefitCatalogError && error.code === "upstream",
  );
});
