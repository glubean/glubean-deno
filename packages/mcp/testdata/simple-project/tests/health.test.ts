import { test } from "@glubean/sdk";

export const healthCheck = test(
  "health-check",
  async (ctx) => {
    ctx.assert(true, "always passes");
    ctx.log("health check executed");
  },
);
