import assert from "node:assert/strict";
import test from "node:test";
import { getUniqueHumanDeal, listUniqueHumanDeals } from "../worker/deals.ts";
import type { Env } from "../worker/types.ts";

const env = { HUMAN_REQUIRED_ORIGIN: "https://humanrequired.shop" } as Env;

const catalog = {
  products: [
    {
      title: "Unique Human Hat",
      handle: "unique-human-hat",
      tags: ["collection:Unique human of SF"],
      variants: [{ title: "Default Title", price: "35.00", available: true }],
    },
    {
      title: "Unique Human Jacket",
      handle: "unique-human-jacket",
      tags: ["collection:Unique human of SF"],
      variants: [
        { title: "Small", price: "140.00", available: false },
        { title: "Medium", price: "140.00", available: true },
      ],
    },
    {
      title: "Cyto Liftoff Sneaker",
      handle: "cytoshift",
      tags: ["world-id-gated"],
      variants: [{ title: "10", price: "160.00", available: true }],
    },
  ],
};

function mockCatalog(t: test.TestContext): void {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(catalog), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
}

test("lists focused unique-human deals from live catalog data", async (t) => {
  mockCatalog(t);
  const result = await listUniqueHumanDeals(env);
  assert.equal(result.deals.length, 2);
  assert.deepEqual(result.deals.map((deal) => deal.id), [
    "unique-human-sf-15",
    "cyto-liftoff-exclusive",
  ]);
  assert.deepEqual(result.deals[0], {
    id: "unique-human-sf-15",
    title: "15% off Unique Human of SF",
    benefit: "15% off eligible Unique Human of SF products",
    kind: "discount",
    availability: "available",
    eligible_product_count: 2,
    in_stock_product_count: 2,
    store_url: "https://humanrequired.shop/#shop",
    requires_store_world_id_verification: true,
    chatgpt_claim_available: true,
  });
});

test("returns products, prices, options, and store handoff for one deal", async (t) => {
  mockCatalog(t);
  const result = await getUniqueHumanDeal(env, "unique-human-sf-15");
  assert.equal(result.products.length, 2);
  assert.deepEqual(result.products[1], {
    title: "Unique Human Jacket",
    price: "$140.00",
    currency: "USD",
    available: true,
    available_options: ["Medium"],
    product_url: "https://humanrequired.shop/products/unique-human-jacket",
  });
  assert.equal(result.requires_store_world_id_verification, true);
});

test("rejects a non-HTTPS configured store origin", async () => {
  await assert.rejects(
    listUniqueHumanDeals({ HUMAN_REQUIRED_ORIGIN: "http://humanrequired.shop" } as Env),
    /Invalid Human Required store origin/u,
  );
});

test("identifies catalog requests so Shopify does not reject the Worker client", async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(
      headers.get("user-agent"),
      "World-ID-Deals/1.0 (+https://world-id-chatgpt.foundry-world.workers.dev)",
    );
    return new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const result = await listUniqueHumanDeals(env);
  assert.equal(result.deals.length, 2);
});
