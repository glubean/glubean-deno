import { test } from "@glubean/sdk";

export const failingTest = test(
  "always-fails",
  async (ctx) => {
    ctx.assert(false, "this should fail");
  },
);
