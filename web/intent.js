import { CredentialRequest, IDKit, any } from "@worldcoin/idkit-core";
import QRCode from "qrcode";

const approvalId = location.pathname.split("/").filter(Boolean).at(-1);
const statusEl = document.querySelector("#status");
const detailEl = document.querySelector("#detail");
const approveButton = document.querySelector("#approve-button");
const worldLink = document.querySelector("#world-link");
const receiptLink = document.querySelector("#receipt-link");
const qr = document.querySelector("#qr");
let config;

const getJson = async (url, options) => {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
};

const setState = (state, title, detail) => {
  document.body.dataset.state = state;
  statusEl.textContent = title;
  detailEl.textContent = detail;
};

const showIntent = (value) => {
  document.querySelector("#intent-card").hidden = false;
  document.querySelector("#intent-title").textContent = value.intent.title;
  document.querySelector("#intent-instruction").textContent = value.intent.instruction;
  document.querySelector("#intent-hash").textContent = value.intent_hash;
  if (value.intent.audience) {
    document.querySelector("#audience-row").hidden = false;
    document.querySelector("#intent-audience").textContent = value.intent.audience;
  }
  if (value.intent.constraints.length > 0) {
    document.querySelector("#constraints-row").hidden = false;
    const list = document.querySelector("#intent-constraints");
    for (const constraint of value.intent.constraints) {
      const item = document.createElement("li");
      item.textContent = constraint;
      list.append(item);
    }
  }
  if (value.valid_until) {
    document.querySelector("#validity-row").hidden = false;
    document.querySelector("#intent-validity").textContent = new Date(value.valid_until).toLocaleString();
  }
};

const showApproved = (receiptUrl) => {
  approveButton.hidden = true;
  worldLink.hidden = true;
  qr.hidden = true;
  receiptLink.href = receiptUrl;
  receiptLink.hidden = false;
  setState("approved", "Instruction approved", "The receipt is ready. Return to ChatGPT, or open the public verification page.");
};

const approve = async () => {
  approveButton.disabled = true;
  worldLink.hidden = true;
  qr.hidden = true;
  setState("working", "Waiting for World App", "Preparing an approval bound to the exact intent hash…");
  try {
    config = await getJson(`/api/intents/${approvalId}/config`);
    if (config.status !== "pending") {
      if (config.status === "approved") return showApproved(config.receipt_url);
      throw new Error("This approval link has expired");
    }
    const context = await getJson(`/api/intents/${approvalId}/rp-context`, { method: "POST" });
    const sessionConfig = {
      app_id: config.app_id,
      rp_context: {
        rp_id: context.rp_id,
        nonce: context.nonce,
        created_at: context.created_at,
        expires_at: context.expires_at,
        signature: context.sig,
      },
      action_description: `Approve: ${config.intent.title}`.slice(0, 120),
      require_user_presence: true,
      environment: config.environment,
    };
    const request = await IDKit.proveSession(config.session_id, sessionConfig)
      .constraints(any(CredentialRequest("proof_of_human")));
    worldLink.href = request.connectorURI;
    worldLink.hidden = false;
    await QRCode.toCanvas(qr, request.connectorURI, {
      width: 220,
      margin: 1,
      color: { dark: "#111111", light: "#ffffff" },
    });
    qr.hidden = false;
    setState("working", "Waiting for World App", "Open World App on this device, or scan the QR code with your phone.");
    const completion = await request.pollUntilCompletion({ timeout: 10 * 60_000 });
    if (!completion.success) throw new Error(completion.error.replaceAll("_", " "));
    const accepted = await getJson(`/api/intents/${approvalId}/proof`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(completion.result),
    });
    showApproved(accepted.receipt_url);
  } catch (error) {
    approveButton.disabled = false;
    approveButton.textContent = "Try again";
    setState("error", "Approval didn’t finish", error instanceof Error ? error.message : "Please try again");
  }
};

approveButton.addEventListener("click", approve);

getJson(`/api/intents/${approvalId}/config`)
  .then((value) => {
    config = value;
    showIntent(value);
    if (value.status === "approved") return showApproved(value.receipt_url);
    if (value.status === "expired") {
      approveButton.hidden = true;
      setState("error", "Approval link expired", "Return to ChatGPT and create a new human approval.");
      return;
    }
    approveButton.disabled = false;
  })
  .catch((error) => {
    approveButton.hidden = true;
    setState("error", "Approval couldn’t load", error.message);
  });
