import "dotenv/config";
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { VerificationStore } from "./verification-store.js";
import { createWorldIdService } from "./world-id.js";

const config = loadConfig();
const store = new VerificationStore({ ttlMs: config.verificationTtlMs });
const worldId = createWorldIdService(config.world);
const server = createHttpServer({ config, store, worldId });

server.listen(config.port, () => {
  console.log(`World ID MCP server: http://localhost:${config.port}/mcp`);
  console.log(`Verification links use: ${config.publicBaseUrl}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
