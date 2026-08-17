import { CredentialRequest, IDKit, any } from "@worldcoin/idkit-core";
import QRCode from "qrcode";

const verificationId = location.pathname.split("/").filter(Boolean).at(-1);
const statusEl = document.querySelector("#status");
const detailEl = document.querySelector("#detail");
const buttonEl = document.querySelector("#verify-button");
const worldLinkEl = document.querySelector("#world-link");
const qrEl = document.querySelector("#qr");
const clientEl = document.querySelector("#client-name");

const setState = (state, detail) => {
  document.body.dataset.state = state;
  statusEl.textContent =
    state === "verified"
      ? "You’re verified"
      : state === "working"
        ? "Waiting for World App"
        : state === "error"
          ? "Verification didn’t finish"
          : "Verify your World ID";
  detailEl.textContent = detail;
};

const getJson = async (url, options) => {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
};

const start = async () => {
  buttonEl.disabled = true;
  worldLinkEl.hidden = true;
  qrEl.hidden = true;
  setState("working", "Preparing a private Proof of Human request…");

  try {
    const config = await getJson(`/api/verification/${verificationId}/config`);
    if (config.status === "proof_verified") {
      setState("working", "Finishing the secure connection…");
      const accepted = await getJson(`/api/verification/${verificationId}/proof`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      location.assign(accepted.redirect_url);
      return;
    }
    if (config.status === "completed") throw new Error("This connection has already been completed");
    if (config.status !== "pending") throw new Error("This link has expired");

    const rpContext = await getJson(
      `/api/verification/${verificationId}/rp-context`,
      { method: "POST" },
    );

    const sessionConfig = {
      app_id: config.app_id,
      rp_context: {
        rp_id: rpContext.rp_id,
        nonce: rpContext.nonce,
        created_at: rpContext.created_at,
        expires_at: rpContext.expires_at,
        signature: rpContext.sig,
      },
      action_description: "Connect Proof of Human to an AI assistant",
      require_user_presence: true,
      environment: config.environment,
    };
    const builder = config.mode === "prove_session"
      ? IDKit.proveSession(config.session_id, sessionConfig)
      : IDKit.createSession(sessionConfig);
    const request = await builder.constraints(any(CredentialRequest("proof_of_human")));

    worldLinkEl.href = request.connectorURI;
    worldLinkEl.hidden = false;
    await QRCode.toCanvas(qrEl, request.connectorURI, {
      width: 220,
      margin: 1,
      color: { dark: "#111111", light: "#ffffff" },
    });
    qrEl.hidden = false;
    setState(
      "working",
      "Open World App on this device, or scan the QR code with your phone.",
    );

    const completion = await request.pollUntilCompletion({ timeout: 10 * 60_000 });
    if (!completion.success) throw new Error(completion.error.replaceAll("_", " "));

    const accepted = await getJson(`/api/verification/${verificationId}/proof`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(completion.result),
    });

    worldLinkEl.hidden = true;
    qrEl.hidden = true;
    setState("verified", "World ID verified. Returning to your AI assistant…");
    location.assign(accepted.redirect_url);
  } catch (error) {
    setState("error", error instanceof Error ? error.message : "Please try again");
    buttonEl.disabled = false;
    buttonEl.textContent = "Try again";
  }
};

buttonEl.addEventListener("click", start);

getJson(`/api/verification/${verificationId}/config`)
  .then((config) => {
    clientEl.textContent = config.client_name;
    if (config.status === "completed") {
      buttonEl.hidden = true;
      setState("verified", "This secure connection has already been completed.");
    } else if (config.status === "expired") {
      buttonEl.hidden = true;
      setState("error", "This verification link has expired.");
    }
  })
  .catch((error) => {
    buttonEl.hidden = true;
    setState("error", error.message);
  });
