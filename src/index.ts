#!/usr/bin/env node
import { buildCli } from "./cli.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const program = buildCli();
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error(msg);
  process.exit(1);
});
