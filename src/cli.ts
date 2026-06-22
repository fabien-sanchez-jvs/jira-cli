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
  getBoardsForProject,
  getMyself,
  getTransitions,
  type JiraClientOptions,
  linkIssues,
  setIssueParent,
  transitionIssue,
  updateIssue,
} from "./jira.js";
import type { Sprint } from "./jira.schemas.js";
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

// Extrait la clé de projet d'une clé d'issue : "COM-1812" -> "COM".
function projectFromKey(key: string): string | undefined {
  return /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(key)?.[1];
}

// Parse une spec de blocage compacte autour de la flèche ">", relative à la
// fiche éditée (editedKey) :
//   "AUTRE>"  -> AUTRE bloque la fiche éditée
//   ">AUTRE"  -> la fiche éditée bloque AUTRE
// Retourne le couple prêt pour l'API : outwardKey = bloqueur, inwardKey = bloqué.
function parseBlockSpec(
  spec: string,
  editedKey: string,
): { outwardKey: string; inwardKey: string } {
  const s = spec.trim();
  const invalid = () =>
    new Error(
      `Spec de blocage invalide : "${spec}". Utilise "AUTRE>" (AUTRE bloque ` +
        `la fiche) ou ">AUTRE" (la fiche bloque AUTRE).`,
    );
  if (s.startsWith(">")) {
    const other = s.slice(1).trim();
    if (!other) throw invalid();
    return { outwardKey: editedKey, inwardKey: other };
  }
  if (s.endsWith(">")) {
    const other = s.slice(0, -1).trim();
    if (!other) throw invalid();
    return { outwardKey: other, inwardKey: editedKey };
  }
  throw invalid();
}

// Cherche un sprint par nom dans une liste : correspondance exacte d'abord,
// puis "contient" ; insensible à la casse et aux accents.
function matchSprintByName(
  sprints: Sprint[],
  name: string,
): Sprint | undefined {
  const wanted = normalize(name);
  return (
    sprints.find((s) => normalize(s.name) === wanted) ??
    sprints.find((s) => normalize(s.name).includes(wanted))
  );
}

// Cherche un sprint par nom sur un board donné (erreur listant les sprints
// disponibles si rien ne correspond).
async function resolveSprintOnBoard(
  jira: JiraClientOptions,
  boardId: string,
  sprint: string,
): Promise<number> {
  const sprints = await getBoardSprints(jira, boardId);
  const match = matchSprintByName(sprints, sprint);
  if (!match) {
    const available = sprints.map((s) => s.name).join(" | ") || "(aucun)";
    throw new Error(
      `Sprint "${sprint}" introuvable. Sprints disponibles: ${available}`,
    );
  }
  return match.id;
}

// Résout un sprint par nom quand aucun board n'est fourni : on déduit le board
// à partir des boards scrum du projet. Comme on connaît déjà le nom du sprint,
// on cherche directement sur quels boards il existe. En cas d'ambiguïté
// (plusieurs boards portent ce sprint), on préfère celui où il est ACTIF.
async function resolveSprintFromProject(
  jira: JiraClientOptions,
  sprint: string,
  project: string,
): Promise<number> {
  const scrum = (await getBoardsForProject(jira, project)).filter(
    (b) => b.type === "scrum",
  );
  if (scrum.length === 0) {
    throw new Error(
      `Aucun board scrum trouvé pour le projet ${project}. ` +
        "Fournis --board <id> (ou JIRA_DEFAULT_BOARD).",
    );
  }
  if (scrum.length === 1) {
    return resolveSprintOnBoard(jira, String(scrum[0].id), sprint);
  }

  // Plusieurs boards scrum : on cherche le sprint nommé sur chacun (en parallèle).
  const perBoard = await Promise.all(
    scrum.map(async (board) => ({
      board,
      match: matchSprintByName(
        await getBoardSprints(jira, String(board.id)),
        sprint,
      ),
    })),
  );
  const candidates = perBoard.flatMap((c) =>
    c.match ? [{ board: c.board, match: c.match }] : [],
  );

  if (candidates.length === 0) {
    const boards = scrum.map((b) => `${b.id} (${b.name})`).join(" | ");
    throw new Error(
      `Sprint "${sprint}" introuvable sur les boards scrum de ${project}. ` +
        `Boards consultés: ${boards}`,
    );
  }
  if (candidates.length === 1) return candidates[0].match.id;

  // Ambiguïté : départager via l'état ACTIF du sprint correspondant.
  const active = candidates.filter((c) => c.match.state === "active");
  if (active.length === 1) return active[0].match.id;

  const list = candidates
    .map((c) => `${c.board.id} (${c.board.name})`)
    .join(" | ");
  throw new Error(
    `Plusieurs boards de ${project} contiennent le sprint "${sprint}"` +
      `${active.length > 1 ? " (plusieurs actifs)" : ""} : précise --board <id>. ` +
      `Boards: ${list}`,
  );
}

// Résout un sprint : un id numérique est utilisé tel quel ; sinon on cherche
// par nom sur le board fourni (--board, JIRA_DEFAULT_BOARD), ou à défaut via les
// boards scrum déduits du projet.
async function resolveSprintId(
  jira: JiraClientOptions,
  sprint: string,
  boardId: string | undefined,
  project: string | undefined,
): Promise<number> {
  if (/^\d+$/.test(sprint)) return Number(sprint);
  if (boardId) return resolveSprintOnBoard(jira, boardId, sprint);
  if (!project) {
    throw new Error(
      "Pour cibler un sprint par nom, fournis --board <id> (ou JIRA_DEFAULT_BOARD). " +
        "Tu peux aussi passer directement l'id numérique du sprint.",
    );
  }
  return resolveSprintFromProject(jira, sprint, project);
}

// Détermine le sprint ACTIF à utiliser par défaut à la création (sans --sprint).
// board explicite (--board / JIRA_DEFAULT_BOARD) prioritaire ; sinon on inspecte
// les boards scrum du projet. Retourne undefined si aucun sprint actif unique
// n'est déterminable (0 board, ou 0/plusieurs sprints actifs distincts).
async function resolveActiveSprint(
  jira: JiraClientOptions,
  boardId: string | undefined,
  project: string,
): Promise<Sprint | undefined> {
  const boardIds = boardId
    ? [boardId]
    : (await getBoardsForProject(jira, project))
        .filter((b) => b.type === "scrum")
        .map((b) => String(b.id));
  if (boardIds.length === 0) return undefined;

  const active = (
    await Promise.all(boardIds.map((id) => getBoardSprints(jira, id)))
  )
    .flat()
    .filter((s) => s.state === "active");
  // Dédoublonne : un même sprint peut être listé par plusieurs boards.
  const unique = [...new Map(active.map((s) => [s.id, s])).values()];
  return unique.length === 1 ? unique[0] : undefined;
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
    .option("--epic <KEY>", "Rattacher à une epic (clé de l'epic, ex: COM-100)")
    .option(
      "--block <SPEC>",
      'Lien de blocage : "AUTRE>" (AUTRE bloque la fiche créée) ou ' +
        '">AUTRE" (la fiche créée bloque AUTRE)',
    )
    .option(
      "--sprint <ID|NAME>",
      "Affecter à un sprint (id, ou nom + --board). " +
        "Défaut: le sprint actif du board/projet",
    )
    .option(
      "--no-sprint",
      "Créer hors sprint (désactive le sprint actif par défaut)",
    )
    .option(
      "--board <ID>",
      "Board pour résoudre un sprint par nom (défaut: JIRA_DEFAULT_BOARD, " +
        "sinon board scrum déduit du projet)",
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
        parentKey: opts.epic,
      });

      // Sprint : --sprint <id|nom> explicite ; --no-sprint (opts.sprint===false)
      // pour créer hors sprint ; par défaut on rattache au sprint actif déduit.
      const boardId = opts.board ?? config.JIRA_DEFAULT_BOARD;
      let sprintId: number | undefined;
      let sprintLabel: string | undefined;
      let sprintDefaulted = false;
      if (opts.sprint === false) {
        // création hors sprint
      } else if (opts.sprint) {
        sprintId = await resolveSprintId(jira, opts.sprint, boardId, project);
      } else {
        const active = await resolveActiveSprint(jira, boardId, project);
        if (active) {
          sprintId = active.id;
          sprintLabel = active.name;
          sprintDefaulted = true;
        }
      }
      if (sprintId !== undefined) {
        await addIssueToSprint(jira, sprintId, created.key);
      }

      // Lien de blocage optionnel (--block), relatif à la fiche créée.
      if (opts.block) {
        const { outwardKey, inwardKey } = parseBlockSpec(
          opts.block,
          created.key,
        );
        await linkIssues(jira, { type: "Blocks", outwardKey, inwardKey });
      }

      const url = issueUrl(config.JIRA_URL, created.key);
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              key: created.key,
              url,
              sprint: sprintId ?? null,
              epic: opts.epic ?? null,
              block: opts.block ?? null,
            },
            null,
            2,
          ),
        );
      } else {
        const sprintSuffix =
          sprintId !== undefined
            ? ` — sprint ${sprintLabel ? `« ${sprintLabel} »` : sprintId}${
                sprintDefaulted ? " (actif, défaut)" : ""
              }`
            : "";
        const epicSuffix = opts.epic ? ` — epic ${opts.epic}` : "";
        const blockSuffix = opts.block ? ` — blocage ${opts.block}` : "";
        logger.success(
          `Créé ${created.key} — ${url}${sprintSuffix}${epicSuffix}${blockSuffix}`,
        );
        if (opts.sprint === undefined && sprintId === undefined) {
          logger.info(
            "Aucun sprint actif déterminé : fiche créée hors sprint " +
              "(--sprint pour préciser, --no-sprint pour l'assumer).",
          );
        }
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
      "Board pour résoudre un sprint par nom (défaut: JIRA_DEFAULT_BOARD, " +
        "sinon board scrum déduit du projet)",
    )
    .action(async (issueKey, sprint, opts) => {
      const config = loadConfig();
      const jira = jiraOptsFromConfig(config);
      const boardId = opts.board ?? config.JIRA_DEFAULT_BOARD;
      const sprintId = await resolveSprintId(
        jira,
        sprint,
        boardId,
        projectFromKey(issueKey),
      );
      await addIssueToSprint(jira, sprintId, issueKey);
      logger.success(`${issueKey} affectée au sprint ${sprintId}`);
    });

  program
    .command("epic")
    .argument("<issueKey>", "Clé de la fiche (ex: COM-1234)")
    .argument("<epicKey>", "Clé de l'epic, ou 'none' pour détacher")
    .description("Rattache (ou détache) une fiche à une epic")
    .action(async (issueKey, epicKey) => {
      const config = loadConfig();
      const jira = jiraOptsFromConfig(config);
      const detach = normalize(epicKey) === "none";
      await setIssueParent(jira, issueKey, detach ? null : epicKey);
      if (detach) {
        logger.success(`${issueKey} détachée de son epic`);
      } else {
        logger.success(`${issueKey} rattachée à l'epic ${epicKey}`);
      }
    });

  program
    .command("block")
    .argument("<issueKey>", "Clé de la fiche éditée (ex: COM-1234)")
    .argument(
      "<spec>",
      '"AUTRE>" (AUTRE bloque la fiche) ou ">AUTRE" (la fiche bloque AUTRE)',
    )
    .description("Crée un lien de blocage entre deux fiches")
    .action(async (issueKey, spec) => {
      const config = loadConfig();
      const jira = jiraOptsFromConfig(config);
      const { outwardKey, inwardKey } = parseBlockSpec(spec, issueKey);
      await linkIssues(jira, { type: "Blocks", outwardKey, inwardKey });
      logger.success(`${outwardKey} bloque ${inwardKey}`);
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
