import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Command } from "commander";
import { adfToText, markdownToAdf, parseFrontmatter } from "./adf.js";
import { loadConfig } from "./config.js";
import { buildManifest, renderMarkdown, toJson } from "./describe.js";
import {
  addComment,
  addIssueToSprint,
  assignIssue,
  createIssue,
  downloadAttachment,
  findUserByEmail,
  getAttachments,
  getBoardSprints,
  getBoardsForProject,
  getIssue,
  getMyself,
  getTransitions,
  type JiraClientOptions,
  linkIssues,
  setIssueParent,
  transitionIssue,
  updateIssue,
  uploadAttachments,
} from "./jira.js";
import type { AdfNode, Sprint } from "./jira.schemas.js";
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

// Taille lisible (o / Ko / Mo) pour l'affichage des pièces jointes.
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
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

type DescriptionRead = {
  content: string | AdfNode | undefined;
  // Champs extraits du frontmatter YAML (uniquement pour les .md)
  frontmatter: Record<string, string>;
};

// Récupère la description depuis --description, --description-file <path>,
// ou stdin si --description-file vaut "-".
// Les fichiers .md sont convertis en ADF et leur frontmatter est renvoyé.
async function readDescription(opts: {
  description?: string;
  descriptionFile?: string;
}): Promise<DescriptionRead> {
  if (opts.descriptionFile) {
    const text =
      opts.descriptionFile === "-"
        ? await readStdin()
        : readFileSync(resolve(opts.descriptionFile), "utf8");
    if (opts.descriptionFile !== "-" && opts.descriptionFile.endsWith(".md")) {
      return {
        content: markdownToAdf(text),
        frontmatter: parseFrontmatter(text),
      };
    }
    return { content: text, frontmatter: {} };
  }
  return { content: opts.description, frontmatter: {} };
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
    .option(
      "-s, --summary <TEXT>",
      "Titre de la fiche (ou title: dans le frontmatter)",
    )
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

      // Lire la description en premier pour accéder au frontmatter YAML.
      const { content: description, frontmatter } = await readDescription(opts);

      // Résolution des champs : CLI > frontmatter > config/défauts.
      const summary = opts.summary ?? frontmatter.title;
      if (!summary) {
        throw new Error(
          "--summary requis (ou ajoute title: dans le frontmatter du fichier .md).",
        );
      }
      const project =
        opts.project ?? frontmatter.project ?? config.JIRA_DEFAULT_PROJECT;
      if (!project) {
        throw new Error("--project requis (ou définis JIRA_DEFAULT_PROJECT).");
      }
      const type = opts.type ?? frontmatter.type ?? config.JIRA_DEFAULT_TYPE;
      if (!type) {
        throw new Error("--type requis (ou définis JIRA_DEFAULT_TYPE).");
      }
      const effectiveEpic = opts.epic ?? frontmatter.epic;
      const effectiveBlock = opts.block ?? frontmatter.block;

      let assigneeAccountId: string | null | undefined;
      const assigneeInput = opts.assignee ?? frontmatter.assignee;
      if (assigneeInput) {
        assigneeAccountId = await resolveAccountId(jira, assigneeInput);
      }

      const created = await createIssue(jira, {
        projectKey: project,
        issueType: type,
        summary,
        description,
        assigneeAccountId,
        parentKey: effectiveEpic,
      });

      // Sprint : --sprint > frontmatter sprint: > sprint actif ; --no-sprint annule tout.
      const boardId = opts.board ?? config.JIRA_DEFAULT_BOARD;
      let sprintId: number | undefined;
      let sprintLabel: string | undefined;
      let sprintDefaulted = false;
      const sprintSpec =
        opts.sprint !== undefined ? opts.sprint : frontmatter.sprint;
      if (sprintSpec === false) {
        // création hors sprint (--no-sprint)
      } else if (sprintSpec) {
        sprintId = await resolveSprintId(jira, sprintSpec, boardId, project);
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

      // Lien de blocage optionnel (--block ou block: dans le frontmatter).
      if (effectiveBlock) {
        const { outwardKey, inwardKey } = parseBlockSpec(
          effectiveBlock,
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
              epic: effectiveEpic ?? null,
              block: effectiveBlock ?? null,
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
        const epicSuffix = effectiveEpic ? ` — epic ${effectiveEpic}` : "";
        const blockSuffix = effectiveBlock
          ? ` — blocage ${effectiveBlock}`
          : "";
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
      const { content: description, frontmatter } = await readDescription(opts);
      const summary = opts.summary ?? frontmatter.title;
      await updateIssue(jira, issueKey, {
        summary,
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
    .command("attach")
    .argument("<issueKey>", "Clé de la fiche (ex: COM-1234)")
    .argument("<files...>", "Chemins des fichiers à joindre")
    .description("Ajoute une ou plusieurs pièces jointes à une fiche")
    .action(async (issueKey, files: string[]) => {
      const config = loadConfig();
      const jira = jiraOptsFromConfig(config);
      const payload = files.map((p) => {
        const abs = resolve(p);
        return { filename: basename(abs), data: readFileSync(abs) };
      });
      const uploaded = await uploadAttachments(jira, issueKey, payload);
      logger.success(
        `${uploaded.length} pièce(s) jointe(s) ajoutée(s) à ${issueKey} : ` +
          uploaded.map((a) => a.filename).join(", "),
      );
    });

  program
    .command("attachments")
    .argument("<issueKey>", "Clé de la fiche (ex: COM-1234)")
    .description("Liste les pièces jointes d'une fiche")
    .action(async (issueKey) => {
      const config = loadConfig();
      const jira = jiraOptsFromConfig(config);
      const list = await getAttachments(jira, issueKey);
      if (list.length === 0) {
        logger.info(`Aucune pièce jointe sur ${issueKey}.`);
        return;
      }
      logger.info(`Pièces jointes de ${issueKey} :`);
      for (const a of list) {
        logger.info(`  • ${a.filename} (${formatSize(a.size)}, id ${a.id})`);
      }
    });

  program
    .command("download")
    .argument("<issueKey>", "Clé de la fiche (ex: COM-1234)")
    .argument("<target>", "Nom de fichier, id d'attachement, ou 'all'")
    .description(
      "Télécharge une (ou toutes les) pièce(s) jointe(s) d'une fiche",
    )
    .option("--out <DIR>", "Dossier de sortie (défaut: dossier courant)")
    .action(async (issueKey, target, opts) => {
      const config = loadConfig();
      const jira = jiraOptsFromConfig(config);
      const list = await getAttachments(jira, issueKey);
      if (list.length === 0) {
        throw new Error(`Aucune pièce jointe sur ${issueKey}.`);
      }

      const wanted =
        normalize(target) === "all"
          ? list
          : list.filter(
              (a) =>
                a.id === target || normalize(a.filename) === normalize(target),
            );
      if (wanted.length === 0) {
        const available = list
          .map((a) => `${a.filename} (id ${a.id})`)
          .join(" | ");
        throw new Error(
          `Pièce jointe "${target}" introuvable sur ${issueKey}. ` +
            `Disponibles: ${available}`,
        );
      }

      const outDir = opts.out ? resolve(opts.out) : process.cwd();
      const used = new Set<string>();
      for (const a of wanted) {
        // Évite d'écraser deux PJ de même nom (Jira l'autorise) : préfixe l'id.
        const name = used.has(a.filename)
          ? `${a.id}-${a.filename}`
          : a.filename;
        used.add(name);
        const dest = join(outDir, name);
        writeFileSync(dest, await downloadAttachment(jira, a));
        logger.success(`Téléchargé ${a.filename} → ${dest}`);
      }
    });

  program
    .command("comment")
    .argument("<issueKey>", "Clé de la fiche (ex: COM-1234)")
    .argument("[text]", "Texte du commentaire (alternatif : --file)")
    .description("Ajoute un commentaire à une fiche")
    .option(
      "--file <PATH>",
      "Lire le commentaire depuis un fichier ('-' = stdin)",
    )
    .action(async (issueKey, text, opts) => {
      const content = opts.file
        ? opts.file === "-"
          ? await readStdin()
          : readFileSync(resolve(opts.file), "utf8")
        : text;
      if (!content?.trim()) {
        throw new Error(
          "Texte requis : fournis le commentaire en argument ou via --file.",
        );
      }
      const config = loadConfig();
      const jira = jiraOptsFromConfig(config);
      await addComment(jira, issueKey, content);
      logger.success(
        `Commentaire ajouté à ${issueKey} — ${issueUrl(config.JIRA_URL, issueKey)}`,
      );
    });

  program
    .command("get")
    .argument("<issueKey>", "Clé de la fiche (ex: COM-1234)")
    .description("Affiche le détail complet d'une fiche (lecture)")
    .option("--json", "Sortie JSON", false)
    .action(async (issueKey, opts) => {
      const config = loadConfig();
      const jira = jiraOptsFromConfig(config);
      const issue = await getIssue(jira, issueKey);
      const f = issue.fields;

      const fmtDate = (iso: string | undefined): string => {
        if (!iso) return "—";
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
        return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
      };

      const sprints = f.customfield_10020 ?? [];
      const sprint =
        sprints.find((s) => s.state === "active") ??
        sprints.find((s) => s.state === "future") ??
        sprints[sprints.length - 1];

      const links = f.issuelinks ?? [];
      const subtasks = f.subtasks ?? [];
      const attachments = f.attachment ?? [];
      const comments = f.comment?.comments ?? [];

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              key: issue.key,
              url: issueUrl(config.JIRA_URL, issue.key),
              summary: f.summary,
              type: f.issuetype.name,
              status: f.status.name,
              priority: f.priority?.name ?? null,
              assignee: f.assignee?.displayName ?? null,
              reporter: f.reporter?.displayName ?? null,
              parent: f.parent
                ? {
                    key: f.parent.key,
                    summary: f.parent.fields.summary ?? null,
                    type: f.parent.fields.issuetype?.name ?? null,
                  }
                : null,
              sprint: sprint
                ? { id: sprint.id, name: sprint.name, state: sprint.state }
                : null,
              description: f.description ? adfToText(f.description) : null,
              subtasks: subtasks.map((s) => ({
                key: s.key,
                summary: s.fields.summary ?? null,
                status: s.fields.status?.name ?? null,
                type: s.fields.issuetype?.name ?? null,
              })),
              links: links.map((l) =>
                l.outwardIssue
                  ? {
                      relation: l.type.outward ?? l.type.name,
                      key: l.outwardIssue.key,
                      summary: l.outwardIssue.fields.summary ?? null,
                      status: l.outwardIssue.fields.status?.name ?? null,
                    }
                  : {
                      relation: l.type.inward ?? l.type.name,
                      key: l.inwardIssue?.key ?? null,
                      summary: l.inwardIssue?.fields.summary ?? null,
                      status: l.inwardIssue?.fields.status?.name ?? null,
                    },
              ),
              attachments: attachments.map((a) => ({
                id: a.id,
                filename: a.filename,
                size: a.size,
                mimeType: a.mimeType ?? null,
              })),
              comments: comments.map((c) => ({
                author: c.author?.displayName ?? "?",
                created: fmtDate(c.created),
                body: adfToText(c.body),
              })),
              created: fmtDate(f.created),
              updated: fmtDate(f.updated),
            },
            null,
            2,
          ),
        );
        return;
      }

      const row = (label: string, value: string) =>
        console.log(`  ${label.padEnd(10)}: ${value}`);

      console.log(`\n${issue.key} [${f.issuetype.name}] — ${f.summary}`);
      console.log(`  ${issueUrl(config.JIRA_URL, issue.key)}`);
      console.log("");
      row("Statut", f.status.name);
      if (f.priority) row("Priorité", f.priority.name);
      row("Assigné", f.assignee?.displayName ?? "(non assigné)");
      row("Reporter", f.reporter?.displayName ?? "—");
      if (f.parent) {
        const pt = f.parent.fields.issuetype?.name ?? "?";
        row(
          "Parent",
          `${f.parent.key} (${pt}) — ${f.parent.fields.summary ?? ""}`,
        );
      }
      if (sprint) {
        const stateLabel =
          sprint.state === "active"
            ? " (actif)"
            : sprint.state === "future"
              ? " (à venir)"
              : " (clos)";
        row("Sprint", `${sprint.name}${stateLabel}`);
      } else {
        row("Sprint", "(hors sprint)");
      }
      row("Créé le", fmtDate(f.created));
      row("Modifié", fmtDate(f.updated));

      const descText = f.description ? adfToText(f.description) : null;
      console.log("\nDescription :");
      if (descText) {
        console.log(
          descText
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n"),
        );
      } else {
        console.log("  (aucune)");
      }

      console.log(`\nLiens (${links.length}) :`);
      if (links.length === 0) {
        console.log("  (aucun)");
      } else {
        for (const l of links) {
          if (l.outwardIssue) {
            const rel = l.type.outward ?? l.type.name;
            console.log(
              `  → ${rel} ${l.outwardIssue.key} — ${l.outwardIssue.fields.summary ?? ""}`,
            );
          } else if (l.inwardIssue) {
            const rel = l.type.inward ?? l.type.name;
            console.log(
              `  ← ${rel} ${l.inwardIssue.key} — ${l.inwardIssue.fields.summary ?? ""}`,
            );
          }
        }
      }

      console.log(`\nSous-tâches (${subtasks.length}) :`);
      if (subtasks.length === 0) {
        console.log("  (aucune)");
      } else {
        for (const s of subtasks) {
          const st = s.fields.issuetype?.name ?? "";
          const ss = s.fields.status?.name ?? "?";
          console.log(
            `  • ${s.key} [${st}] [${ss}] — ${s.fields.summary ?? ""}`,
          );
        }
      }

      console.log(`\nPièces jointes (${attachments.length}) :`);
      if (attachments.length === 0) {
        console.log("  (aucune)");
      } else {
        for (const a of attachments) {
          console.log(`  • ${a.filename} (${formatSize(a.size)}, id ${a.id})`);
        }
      }

      console.log(`\nCommentaires (${comments.length}) :`);
      if (comments.length === 0) {
        console.log("  (aucun)");
      } else {
        for (const c of comments) {
          const author = c.author?.displayName ?? "?";
          console.log(`  [${author} – ${fmtDate(c.created)}]`);
          const body = adfToText(c.body);
          console.log(
            body
              .split("\n")
              .map((l) => `  ${l}`)
              .join("\n"),
          );
          console.log("");
        }
      }
      console.log("");
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
