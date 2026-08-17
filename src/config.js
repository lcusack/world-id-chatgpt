const required = (env, name) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const positiveInteger = (value, fallback, name) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

export function loadConfig(env = process.env) {
  const port = positiveInteger(env.PORT, 8787, "PORT");
  const environment = env.WORLD_ENVIRONMENT?.trim() || "staging";
  if (!new Set(["staging", "production"]).has(environment)) {
    throw new Error("WORLD_ENVIRONMENT must be staging or production");
  }

  const publicBaseUrl = new URL(
    env.PUBLIC_BASE_URL?.trim() || `http://localhost:${port}`,
  );

  return {
    port,
    publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
    verificationTtlMs:
      positiveInteger(
        env.VERIFICATION_TTL_SECONDS,
        600,
        "VERIFICATION_TTL_SECONDS",
      ) * 1_000,
    world: {
      appId: required(env, "WORLD_APP_ID"),
      rpId: required(env, "WORLD_RP_ID"),
      signingKey: required(env, "WORLD_RP_SIGNING_KEY"),
      action: env.WORLD_ACTION?.trim() || "link-chatgpt",
      environment,
    },
  };
}
