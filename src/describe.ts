import type { Command } from "commander";

// Vue minimale sur les internes de commander (évite `any` tout en accédant
// aux options/arguments introspectables).
interface CommanderOption {
  flags: string;
  description: string;
  mandatory: boolean;
  defaultValue?: unknown;
}

interface CommanderArgument {
  name(): string;
  description: string;
  required: boolean;
  variadic: boolean;
}

type IntrospectableCommand = Command & {
  options: CommanderOption[];
  registeredArguments: CommanderArgument[];
};

// Commandes exclues du manifeste (méta / non métier).
const EXCLUDED = new Set(["help", "describe"]);

const TOOL_PURPOSE =
  "CLI pour créer et modifier des fiches Jira (Jira Cloud). " +
  "Complète le connecteur Atlassian (lecture seule) en apportant les écritures : " +
  "création, mise à jour, affectation, transition de statut, ajout à un sprint.";

const INVOCATION_NOTES = [
  "Invocation par le shell : `jira <commande> [options]`.",
  "Authentification via variables d'environnement : `JIRA_URL`, `JIRA_EMAIL`, " +
    "`JIRA_API_TOKEN` (token API Atlassian, auth Basic). L'outil agit avec les " +
    "droits Jira de l'utilisateur.",
  "Défauts optionnels : `JIRA_DEFAULT_PROJECT`, `JIRA_DEFAULT_TYPE`, " +
    "`JIRA_DEFAULT_BOARD` (évitent de répéter les flags).",
  "Sortie : messages lisibles sur stdout. Code de sortie 0 = succès, " +
    "1 = erreur (message sur stderr).",
  '`create --json` produit une sortie machine `{ "key", "url" }` à parser.',
  "`DEBUG=1` affiche les requêtes HTTP (debug).",
];

const USAGE_RULES = [
  "AVANT de transitionner, lancer `jira transition <key>` SANS statut : cela " +
    "liste les transitions possibles (lecture seule, sans effet) et donne les " +
    "libellés exacts à utiliser.",
  "Affecter à un sprint par NOM nécessite un board. Ordre de résolution : " +
    "`--board <id>`, sinon `JIRA_DEFAULT_BOARD`, sinon déduction depuis les " +
    "boards scrum du projet — on cherche le sprint nommé sur chacun ; s'il " +
    "n'existe que sur un board, il est choisi ; si plusieurs boards le portent, " +
    "on prend celui où le sprint est ACTIF, sinon erreur (préciser `--board`). " +
    "Un id numérique de sprint fonctionne sans board.",
  "`update` ÉCRASE le titre et/ou la description fournis (pas de fusion).",
  "Les noms de statut et de sprint sont résolus de façon insensible à la casse " +
    "et aux accents.",
  "La description est convertie en ADF automatiquement ; le formatage riche " +
    "(gras, listes…) n'est pas interprété.",
];

// Exemples curatés par commande (commander ne les expose pas).
const EXAMPLES: Record<string, string[]> = {
  create: [
    'jira create -s "Bouton export grisé sur mobile" -t Bug -d "Détail du bug…"',
    'jira create -s "Refonte du header" --description-file ./desc.md',
    'jira create -s "Titre" -a moi@jvs.fr --sprint "Sprint 42" --board 123',
    'jira create -s "Titre" --json',
  ],
  update: [
    'jira update COM-1234 -s "Nouveau titre"',
    "jira update COM-1234 --description-file ./nouvelle-desc.md",
  ],
  assign: [
    "jira assign COM-1234 collegue@jvs.fr",
    "jira assign COM-1234 me",
    "jira assign COM-1234 unassign",
  ],
  transition: [
    "jira transition COM-1234",
    'jira transition COM-1234 "En cours"',
  ],
  sprint: [
    "jira sprint COM-1234 456",
    'jira sprint COM-1234 "Sprint 42" --board 123',
  ],
};

export interface OptionDoc {
  flags: string;
  description: string;
  required: boolean;
  default?: unknown;
}

export interface ArgumentDoc {
  name: string;
  description: string;
  required: boolean;
  variadic: boolean;
}

export interface CommandDoc {
  name: string;
  description: string;
  usage: string;
  arguments: ArgumentDoc[];
  options: OptionDoc[];
  examples: string[];
}

export interface Manifest {
  name: string;
  description: string;
  invocation: string[];
  rules: string[];
  commands: CommandDoc[];
}

function argUsage(arg: ArgumentDoc): string {
  const inner = arg.variadic ? `${arg.name}...` : arg.name;
  return arg.required ? `<${inner}>` : `[${inner}]`;
}

function describeCommand(programName: string, cmd: Command): CommandDoc {
  const introspectable = cmd as IntrospectableCommand;
  const args: ArgumentDoc[] = (introspectable.registeredArguments ?? []).map(
    (a) => ({
      name: a.name(),
      description: a.description ?? "",
      required: a.required,
      variadic: a.variadic,
    }),
  );
  const options: OptionDoc[] = (introspectable.options ?? []).map((o) => ({
    flags: o.flags,
    description: o.description ?? "",
    required: o.mandatory,
    default: o.defaultValue,
  }));

  const hasOptions = options.length > 0;
  const usageParts = [
    programName,
    cmd.name(),
    hasOptions ? "[options]" : "",
    ...args.map(argUsage),
  ].filter(Boolean);

  return {
    name: cmd.name(),
    description: cmd.description(),
    usage: usageParts.join(" "),
    arguments: args,
    options,
    examples: EXAMPLES[cmd.name()] ?? [],
  };
}

export function buildManifest(program: Command): Manifest {
  const commands = program.commands
    .filter((c) => !EXCLUDED.has(c.name()))
    .map((c) => describeCommand(program.name(), c));

  return {
    name: program.name(),
    description: TOOL_PURPOSE,
    invocation: INVOCATION_NOTES,
    rules: USAGE_RULES,
    commands,
  };
}

export function toJson(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2);
}

export function renderMarkdown(manifest: Manifest): string {
  const lines: string[] = [];

  lines.push(`# ${manifest.name} — manifeste d'outil pour agent IA`);
  lines.push("");
  lines.push(manifest.description);
  lines.push("");

  lines.push("## Invocation");
  lines.push("");
  for (const note of manifest.invocation) lines.push(`- ${note}`);
  lines.push("");

  lines.push("## Règles importantes");
  lines.push("");
  for (const rule of manifest.rules) lines.push(`- ${rule}`);
  lines.push("");

  lines.push("## Commandes");
  lines.push("");

  for (const cmd of manifest.commands) {
    lines.push(`### \`${cmd.name}\``);
    lines.push("");
    lines.push(cmd.description);
    lines.push("");
    lines.push("```");
    lines.push(cmd.usage);
    lines.push("```");
    lines.push("");

    if (cmd.arguments.length > 0) {
      lines.push("**Arguments**");
      lines.push("");
      for (const arg of cmd.arguments) {
        const req = arg.required ? "requis" : "optionnel";
        lines.push(`- \`${argUsage(arg)}\` (${req}) — ${arg.description}`);
      }
      lines.push("");
    }

    if (cmd.options.length > 0) {
      lines.push("**Options**");
      lines.push("");
      for (const opt of cmd.options) {
        const tags: string[] = [];
        if (opt.required) tags.push("requis");
        if (opt.default !== undefined && opt.default !== false) {
          tags.push(`défaut: ${JSON.stringify(opt.default)}`);
        }
        const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
        lines.push(`- \`${opt.flags}\`${suffix} — ${opt.description}`);
      }
      lines.push("");
    }

    if (cmd.examples.length > 0) {
      lines.push("**Exemples**");
      lines.push("");
      lines.push("```bash");
      for (const ex of cmd.examples) lines.push(ex);
      lines.push("```");
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
