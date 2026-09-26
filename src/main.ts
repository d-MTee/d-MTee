// Entry point for the demo trading and signing service.
import { env } from "./config/env.js";
import { startMarketSimulator } from "./market/simulator.js";
import { createServer } from "./api/server.js";
import { initKey } from "./security/keys.js";

startMarketSimulator();
await initKey();

const app = createServer();
app.listen(env.PORT, () => {
  console.log(`mini-dflow-realworld listening on :${env.PORT}`);
});
