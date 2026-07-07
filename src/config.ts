import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

// Charge .env depuis cwd en priorité, puis depuis le dossier du binaire installé.
// L'utilisateur peut donc avoir une config globale, overridable par projet.
function loadEnvFiles(): void {
  const cwdEnv = resolve(process.cwd(), ".env");
  if (existsSync(cwdEnv)) {
    dotenv.config({ path: cwdEnv });
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const installEnv = resolve(here, "..", ".env");
  if (existsSync(installEnv) && installEnv !== cwdEnv) {
    dotenv.config({ path: installEnv });
  }
}

const ConfigSchema = z.object({
  JIRA_URL: z.string().url("JIRA_URL must be a valid URL"),
  JIRA_EMAIL: z.string().email("JIRA_EMAIL must be a valid email"),
  JIRA_API_TOKEN: z.string().min(1, "JIRA_API_TOKEN is required"),
  // Défauts optionnels : évitent de répéter --project / --type / --board.
  JIRA_DEFAULT_PROJECT: z.string().optional(),
  JIRA_DEFAULT_TYPE: z.string().optional(),
  JIRA_DEFAULT_BOARD: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  loadEnvFiles();
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
