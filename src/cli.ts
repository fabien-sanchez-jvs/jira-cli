import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { buildManifest, renderMarkdown, toJson } from "./describe.js";
import {
  addIssueToSprint,
  assignIssue,
  createIssue,
  findUserByEmail,
  getBoardSprints,
  getMyself,
  getTransitions,
  type JiraClientOptions,
  transitionIssue,
  updateIssue,
} from "./jira.js";
import { logger } from "./logger.js";

function jiraOptsFromConfig(config: {
  JIRA_URL: string;
  JIRA_EMAIL: string;
  JIRA_API_TOKEN: string;
}): JiraClientOptions {
  return {
    baseUrl: config.JIRA_URL,
    email: config.JIRA_EMAIL,
    token: config.JIRA_API_TOKEN,
  };
}

function issueUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/$/, "")}/browse/${key}`;
}

function normalize(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function readStdin(): Promise<string> {
  return new Promise((resolveStdin, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolveStdin(data));
    process.stdin.on("error", reject);
  });
}

// Récupère la description depuis --description, --description-file <path>,
// ou stdin si --description-file vaut "-". Retourne undefined si rien fourni.
async function readDescription(opts: {
  description?: string;
  descriptionFile?: string;
}): Promise<string | undefined> {
  if (opts.descriptionFile) {
    if (opts.descriptionFile === "-") return await readStdin();
    return readFileSync(resolve(opts.descriptionFile), "utf8");
  }
  return opts.description;
}

// Résout un assigné en accountId :
//   "unassign" -> null (désassigne) ; "me" -> utilisateur courant ;
//   email -> recherche ; sinon la valeur est supposée être un accountId.
async function resolveAccountId(
  jira: JiraClientOptions,
  assignee: string,
): Promise<string | null> {
  if (assignee === "unassign") return null;
  if (assignee === "me") return (await getMyself(jira)).accountId;
  if (assignee.includes("@")) {
    return (await findUserByEmail(jira, assignee)).accountId;
  }
  return assignee;
}

// Résout un sprint : un id numérique est utilisé tel quel ; sinon on cherche
// par nom parmi les sprints actifs/futurs du board (--board requis).
async function resolveSprintId(
  jira: JiraClientOptions,
  sprint: string,
  boardId: string | undefined,
): Promise<number> {
  if (/^\d+$/.test(sprint)) return Number(sprint);
  if (!boardId) {
    throw new Error(
      "Pour cibler un sprint par nom, fournis --board <id> (ou JIRA_DEFAULT_BOARD). " +
        "Tu peux aussi passer directement l'id numérique du sprint.",
    );
  }
  const sprints = await getBoardSprints(jira, boardId);
  const wanted = normalize(sprint);
  const match =
    sprints.find((s) => normalize(s.name) === wanted) ??
    sprints.find((s) => normalize(s.name).includes(wanted));
  if (!match) {
    const available = sprints.map((s) => s.name).join(" | ") || "(aucun)";
    throw new Error(
      `Sprint "${sprint}" introuvable. Sprints disponibles: ${available}`,
    );
  }
  return match.id;
}

export function buildCli(): Command {
  const program = new Command();

  program
    .name("jira")
    .description("Crée et modifie des fiches Jira (Jira Cloud)")
    .version("0.1.0");

  program
    .command("create")
    .description("Crée une fiche Jira")
    .option(
      "-p, --project <KEY>",
      "Clé du projet (défaut: JIRA_DEFAULT_PROJECT)",
    )
    .option("-t, --type <TYPE>", "Type de ticket (défaut: JIRA_DEFAULT_TYPE)")
    .requiredOption("-s, --summary <TEXT>", "Titre de la fiche")
    .option("-d, --description <TEXT>", "Description (texte brut)")
    .option(
      "--description-file <PATH>",
      "Lire la description depuis un fichier ('-' = stdin)",
    )
    .option("-a, --assignee <USER>", "Assigné: email | me | accountId")
    .option("--sprint <ID|NAME>", "Affecter à un sprint (id, ou nom + --board)")
    .option(
      "--board <ID>",
      "Board pour résoudre un sprint par nom (défaut: JIRA_DEFAULT_BOARD)",
    )
    .option("--json", "Sortie JSON", false)
    .action(async (opts) => {
      const config = loadConfig();
      const jira = jiraOptsFromConfig(config);

      const project = opts.project ?? config.JIRA_DEFAULT_PROJECT;
      if (!project) {
        throw new Error("--project requis (ou définis JIRA_DEFAULT_PROJECT).");
      }
      const type = opts.type ?? config.JIRA_DEFAULT_TYPE;
      if (!type) {
        throw new Error("--type requis (ou définis JIRA_DEFAULT_TYPE).");
      }

      const description = await readDescription(opts);
      let assigneeAccountId: string | null | undefined;
      if (opts.assignee) {
        assigneeAccountId = await resolveAccountId(jira, opts.assignee);
      }

      const created = await createIssue(jira, {
        projectKey: project,
        issueType: type,
        summary: opts.summary,
        description,
        assigneeAccountId,
      });

      if (opts.sprint) {
        const boardId = opts.board ?? config.JIRA_DEFAULT_BOARD;
        const sprintId = await resolveSprintId(jira, opts.sprint, boardId);
        await addIssueToSprint(jira, sprintId, created.key);
      }

      const url = issueUrl(config.JIRA_URL, created.key);
      if (opts.json) {
        console.log(JSON.stringify({ key: created.key, url }, null, 2));
      } else {
        logger.success(`Créé ${created.key} — ${url}`);
      }
    });

  program
    .command("update")
    .argument("<issueKey>", "Clé de la fiche (ex: COM-1234)")
    .description("Modifie le titre et/ou la description d'une fiche")
    .option("-s, --summary <TEXT>", "Nouveau titre")
    .option("-d, --description <TEXT>", "Nouvelle description (texte brut)")
    .option(
      "--description-file <PATH>",
      "Lire la description depuis un fichier ('-' = stdin)",
    )
    .action(async (issueKey, opts) => {
      if (!opts.summary && !opts.description && !opts.descriptionFile) {
        throw new Error(
          "Rien à modifier : fournis --summary et/ou --description.",
        );
      }
      const config = loadConfig();
      const jira = jiraOptsFromConfig(config);
      const description = await readDescription(opts);
      await updateIssue(jira, issueKey, {
        summary: opts.summary,
        description,
      });
      logger.success(
        `Mis à jour ${issueKey} — ${issueUrl(config.JIRA_URL, issueKey)}`,
      );
    });

  program
    .command("assign")
    .argument("<issueKey>", "Clé de la fiche (ex: COM-1234)")
    .argument("<assignee>", "email | me | unassign | accountId")
    .description("Affecte (ou désaffecte) une fiche à un utilisateur")
    .action(async (issueKey, assignee) => {
      const config = loadConfig();
      const jira = jiraOptsFromConfig(config);
      const accountId = await resolveAccountId(jira, assignee);
      await assignIssue(jira, issueKey, accountId);
      if (accountId === null) {
        logger.success(`Désassigné ${issueKey}`);
      } else {
        logger.success(`Assigné ${issueKey} → ${assignee}`);
      }
    });

  program
    .command("transition")
    .argument("<issueKey>", "Clé de la fiche (ex: COM-1234)")
    .argument("[status]", "Statut cible ; absent = liste les transitions")
    .description("Transitionne une fiche, ou liste les transitions possibles")
    .action(async (issueKey, status) => {
      const config = loadConfig();
      const jira = jiraOptsFromConfig(config);
      const transitions = await getTransitions(jira, issueKey);

      if (!status) {
        logger.info(`Transitions disponibles pour ${issueKey} :`);
        for (const t of transitions) {
          logger.info(`  • ${t.name}${t.to ? ` → ${t.to.name}` : ""}`);
        }
        return;
      }

      const wanted = normalize(status);
      const match =
        transitions.find((t) => normalize(t.name) === wanted) ??
        transitions.find((t) => t.to && normalize(t.to.name) === wanted);
      if (!match) {
        const available =
          transitions.map((t) => t.name).join(" | ") || "(aucune)";
        throw new Error(
          `Transition "${status}" indisponible pour ${issueKey}. ` +
            `Transitions possibles: ${available}`,
        );
      }
      await transitionIssue(jira, issueKey, match.id);
      logger.success(`${issueKey} → ${match.to?.name ?? match.name}`);
    });

  program
    .command("sprint")
    .argument("<issueKey>", "Clé de la fiche (ex: COM-1234)")
    .argument("<sprint>", "Id du sprint, ou nom (avec --board)")
    .description("Affecte une fiche à un sprint")
    .option(
      "--board <ID>",
      "Board pour résoudre un sprint par nom (défaut: JIRA_DEFAULT_BOARD)",
    )
    .action(async (issueKey, sprint, opts) => {
      const config = loadConfig();
      const jira = jiraOptsFromConfig(config);
      const boardId = opts.board ?? config.JIRA_DEFAULT_BOARD;
      const sprintId = await resolveSprintId(jira, sprint, boardId);
      await addIssueToSprint(jira, sprintId, issueKey);
      logger.success(`${issueKey} affectée au sprint ${sprintId}`);
    });

  program
    .command("describe")
    .description(
      "Génère un fichier décrivant l'outil (commandes, options, règles) " +
        "destiné à être lu par un agent IA",
    )
    .option("-f, --format <FORMAT>", "Format de sortie : md | json", "md")
    .option(
      "-o, --output <PATH>",
      "Fichier de sortie ('-' pour stdout ; défaut: jira-cli.agent.<ext>)",
    )
    .action((opts) => {
      const format = opts.format === "json" ? "json" : "md";
      const manifest = buildManifest(program);
      const content =
        format === "json" ? toJson(manifest) : renderMarkdown(manifest);

      const output =
        opts.output ??
        (format === "json" ? "jira-cli.agent.json" : "jira-cli.agent.md");

      if (output === "-") {
        console.log(content);
        return;
      }
      const target = resolve(output);
      writeFileSync(target, content, "utf8");
      logger.success(`Description écrite : ${target}`);
    });

  return program;
}
