import assert from "node:assert/strict";
import test from "node:test";
import { createHumanDealClaim, redeemHumanDealClaim } from "../worker/claims.ts";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

class MemoryD1 {
  row = null;

  prepare(sql) {
    let values = [];
    return {
      bind: (...bound) => {
        values = bound;
        return this.prepareBound(sql, () => values);
      },
    };
  }

  prepareBound(sql, values) {
    return {
      first: async () => {
        if (sql.includes("subject_id = ?")) return null;
        if (sql.includes("ticket_hash = ?")) return this.row?.ticket_hash === values()[0] ? this.row : null;
        return null;
      },
      run: async () => {
        const bound = values();
        if (sql.includes("INSERT INTO human_deal_claims")) {
          this.row = {
            ticket_hash: bound[0], ticket_ciphertext: bound[1], ticket_iv: bound[2],
            subject_id: bound[3], deal_id: bound[4], target_path: bound[5],
            discount_code_ciphertext: bound[6], discount_code_iv: bound[7],
            status: "pending", shopify_discount_id: null, last_error_code: null,
            created_at: bound[8], ticket_expires_at: bound[9], discount_expires_at: null, redeemed_at: null,
          };
          return { meta: { changes: 1 } };
        }
        if (sql.includes("status = 'processing'")) {
          if (sql.startsWith("UPDATE") && this.row?.status === "pending") {
            this.row.status = "processing";
            this.row.redeemed_at = bound[0];
            return { meta: { changes: 1 } };
          }
        }
        if (sql.includes("status = 'ready'")) {
          this.row.status = "ready";
          this.row.shopify_discount_id = bound[0];
          this.row.discount_expires_at = bound[1];
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }
}

function environment(db) {
  return {
    DB: db,
    DATA_ENCRYPTION_KEY: encryptionKey,
    PUBLIC_ORIGIN: "https://world-id-chatgpt.foundry-world.workers.dev",
    HUMAN_REQUIRED_ORIGIN: "https://humanrequired.shop",
    SHOPIFY_SHOP_DOMAIN: "human-required.myshopify.com",
    SHOPIFY_ADMIN_API_VERSION: "2026-07",
    SHOPIFY_CLIENT_ID: "shopify-client-id",
    SHOPIFY_CLIENT_SECRET: "shopify-client-secret",
  };
}

const catalog = {
  products: [{
    title: "Unique Human Hat",
    handle: "unique-human-hat",
    tags: ["collection:Unique human of SF"],
    variants: [{ title: "Default Title", price: "35.00", available: true }],
  }],
};

test("carries a verified-human entitlement into a one-use Shopify discount link", async (t) => {
  const db = new MemoryD1();
  const env = environment(db);
  const previousFetch = globalThis.fetch;
  let mutationInput;
  let tokenRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.hostname === "humanrequired.shop") {
      return Response.json(catalog);
    }
    assert.equal(url.hostname, "human-required.myshopify.com");
    if (url.pathname === "/admin/oauth/access_token") {
      tokenRequests += 1;
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("grant_type"), "client_credentials");
      assert.equal(form.get("client_id"), "shopify-client-id");
      assert.equal(form.get("client_secret"), "shopify-client-secret");
      return Response.json({
        access_token: "shopify-short-lived-access-token",
        scope: "read_products,write_discounts",
        expires_in: 86399,
      });
    }
    assert.equal(new Headers(init?.headers).get("x-shopify-access-token"), "shopify-short-lived-access-token");
    const body = JSON.parse(init.body);
    if (body.query.includes("WorldIdClaimProducts")) {
      return Response.json({ data: { products: { nodes: [{
        id: "gid://shopify/Product/1234567890",
        handle: "unique-human-hat",
      }] } } });
    }
    mutationInput = body.variables.input;
    return Response.json({ data: { discountCodeBasicCreate: {
      codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/987654321" },
      userErrors: [],
    } } });
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const claim = await createHumanDealClaim(env, "wid_private_subject", "unique-human-sf-15");
  assert.match(claim.claim_url, /^https:\/\/world-id-chatgpt\.foundry-world\.workers\.dev\/claim\//u);
  assert.equal(claim.claim_url.includes("wid_private_subject"), false);
  assert.equal(db.row.ticket_ciphertext.includes(new URL(claim.claim_url).pathname), false);

  const ticket = new URL(claim.claim_url).pathname.split("/").at(-1);
  const redirect = await redeemHumanDealClaim(env, ticket);
  const url = new URL(redirect);
  assert.equal(url.origin, "https://humanrequired.shop");
  assert.match(url.pathname, /^\/discount\/HUMAN-/u);
  assert.equal(url.searchParams.get("redirect"), "/#shop");
  assert.equal(url.toString().includes("wid_private_subject"), false);
  assert.equal(mutationInput.customerGets.value.percentage, 0.15);
  assert.deepEqual(mutationInput.customerGets.items.products.productsToAdd, ["gid://shopify/Product/1234567890"]);
  assert.equal(mutationInput.usageLimit, 1);
  assert.equal(mutationInput.appliesOncePerCustomer, true);
  assert.equal(tokenRequests, 1);
  assert.equal(db.row.status, "ready");
});

test("does not mint a claim until the Shopify connection is configured", async () => {
  const db = new MemoryD1();
  await assert.rejects(
    createHumanDealClaim({ ...environment(db), SHOPIFY_CLIENT_SECRET: undefined }, "wid_subject", "unique-human-sf-15"),
    (error) => error?.code === "not_configured" && error?.status === 503,
  );
  assert.equal(db.row, null);
});
