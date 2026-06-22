import { textToAdf } from "./adf.js";
import {
  type Attachment,
  AttachmentsResponseSchema,
  type Board,
  BoardSprintsResponseSchema,
  BoardsResponseSchema,
  type CreateIssueResponse,
  CreateIssueResponseSchema,
  IssueAttachmentsSchema,
  type Sprint,
  type Transition,
  TransitionsResponseSchema,
  type User,
  UserSchema,
  UserSearchResponseSchema,
} from "./jira.schemas.js";
import { logger } from "./logger.js";

export interface JiraClientOptions {
  baseUrl: string;
  email: string;
  token: string;
}

function authHeader(email: string, token: string): string {
  const encoded = Buffer.from(`${email}:${token}`).toString("base64");
  return `Basic ${encoded}`;
}

function formatError(status: number, statusText: string, body: string): string {
  try {
    const json = JSON.parse(body) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
    };
    const parts: string[] = [];
    if (Array.isArray(json.errorMessages)) parts.push(...json.errorMessages);
    if (json.errors && typeof json.errors === "object") {
      for (const [field, message] of Object.entries(json.errors)) {
        parts.push(`${field}: ${message}`);
      }
    }
    if (parts.length > 0) {
      return `Jira API ${status} ${statusText}: ${parts.join("; ")}`;
    }
  } catch {
    /* corps non-JSON : on retombe sur le texte brut */
  }
  return `Jira API ${status} ${statusText}: ${body.slice(0, 500)}`;
}

interface RequestOptions {
  body?: unknown;
  // Corps brut (FormData/Blob…) : envoyé tel quel, sans JSON.stringify ni
  // en-tête Content-Type JSON (fetch fixe lui-même le boundary multipart).
  rawBody?: BodyInit;
  // En-têtes additionnels (ex. X-Atlassian-Token pour l'upload).
  headers?: Record<string, string>;
  root?: "platform" | "agile";
  parseJson?: boolean;
  // "json" (défaut) parse la réponse ; "buffer" renvoie le binaire (download).
  responseType?: "json" | "buffer";
}

async function request(
  opts: JiraClientOptions,
  method: string,
  path: string,
  reqOpts: RequestOptions = {},
): Promise<unknown> {
  const {
    body,
    rawBody,
    headers: extraHeaders,
    root = "platform",
    parseJson = true,
    responseType = "json",
  } = reqOpts;
  const base = root === "agile" ? "/rest/agile/1.0" : "/rest/api/3";
  // Un chemin absolu (http…) est utilisé tel quel : ex. l'URL `content` d'une
  // pièce jointe renvoyée par l'API.
  const url = /^https?:\/\//.test(path)
    ? path
    : new URL(base + path, opts.baseUrl).toString();

  logger.debug(
    `${method} ${url}${body ? ` ${JSON.stringify(body).slice(0, 500)}` : ""}`,
  );

  const headers: Record<string, string> = {
    Authorization: authHeader(opts.email, opts.token),
    Accept: responseType === "buffer" ? "*/*" : "application/json",
    ...extraHeaders,
  };
  // Content-Type JSON uniquement pour un corps JSON (pas pour un rawBody).
  if (body !== undefined && rawBody === undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method,
    headers,
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(formatError(res.status, res.statusText, text));
  }

  if (responseType === "buffer") {
    return Buffer.from(await res.arrayBuffer());
  }
  if (!parseJson || res.status === 204) return undefined;
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

export interface CreateIssueInput {
  projectKey: string;
  issueType: string;
  summary: string;
  description?: string;
  assigneeAccountId?: string | null;
  parentKey?: string;
}

export async function createIssue(
  opts: JiraClientOptions,
  input: CreateIssueInput,
): Promise<CreateIssueResponse> {
  const fields: Record<string, unknown> = {
    project: { key: input.projectKey },
    issuetype: { name: input.issueType },
    summary: input.summary,
  };
  if (input.description) fields.description = textToAdf(input.description);
  if (input.assigneeAccountId) {
    fields.assignee = { accountId: input.assigneeAccountId };
  }
  if (input.parentKey) fields.parent = { key: input.parentKey };

  const json = await request(opts, "POST", "/issue", { body: { fields } });
  return CreateIssueResponseSchema.parse(json);
}

export interface UpdateIssueInput {
  summary?: string;
  description?: string;
}

export async function updateIssue(
  opts: JiraClientOptions,
  key: string,
  input: UpdateIssueInput,
): Promise<void> {
  const fields: Record<string, unknown> = {};
  if (input.summary !== undefined) fields.summary = input.summary;
  if (input.description !== undefined) {
    fields.description = textToAdf(input.description);
  }
  await request(opts, "PUT", `/issue/${encodeURIComponent(key)}`, {
    body: { fields },
    parseJson: false,
  });
}

export async function assignIssue(
  opts: JiraClientOptions,
  key: string,
  accountId: string | null,
): Promise<void> {
  await request(opts, "PUT", `/issue/${encodeURIComponent(key)}/assignee`, {
    body: { accountId },
    parseJson: false,
  });
}

// Rattache une fiche à une epic (ou la détache si parentKey est null) via le
// champ `parent` de l'API v3 (Jira Cloud moderne : l'epic est le parent).
export async function setIssueParent(
  opts: JiraClientOptions,
  key: string,
  parentKey: string | null,
): Promise<void> {
  await request(opts, "PUT", `/issue/${encodeURIComponent(key)}`, {
    body: { fields: { parent: parentKey ? { key: parentKey } : null } },
    parseJson: false,
  });
}

export interface LinkIssuesInput {
  type: string;
  // Côté outward du type de lien (ex. pour "Blocks" : le bloqueur, verbe "blocks").
  outwardKey: string;
  // Côté inward du type de lien (ex. pour "Blocks" : le bloqué, "is blocked by").
  inwardKey: string;
}

// Crée un lien entre deux fiches via POST /issueLink.
export async function linkIssues(
  opts: JiraClientOptions,
  input: LinkIssuesInput,
): Promise<void> {
  await request(opts, "POST", "/issueLink", {
    body: {
      type: { name: input.type },
      inwardIssue: { key: input.inwardKey },
      outwardIssue: { key: input.outwardKey },
    },
    parseJson: false,
  });
}

// Liste les pièces jointes d'une issue (champ `attachment`).
export async function getAttachments(
  opts: JiraClientOptions,
  key: string,
): Promise<Attachment[]> {
  const json = await request(
    opts,
    "GET",
    `/issue/${encodeURIComponent(key)}?fields=attachment`,
  );
  return IssueAttachmentsSchema.parse(json).fields.attachment;
}

// Joint un ou plusieurs fichiers à une issue (multipart/form-data).
export async function uploadAttachments(
  opts: JiraClientOptions,
  key: string,
  files: { filename: string; data: Buffer }[],
): Promise<Attachment[]> {
  const form = new FormData();
  for (const f of files) {
    form.append("file", new Blob([new Uint8Array(f.data)]), f.filename);
  }
  const json = await request(
    opts,
    "POST",
    `/issue/${encodeURIComponent(key)}/attachments`,
    { rawBody: form, headers: { "X-Atlassian-Token": "no-check" } },
  );
  return AttachmentsResponseSchema.parse(json);
}

// Télécharge le contenu binaire d'une pièce jointe (via son URL `content`).
export async function downloadAttachment(
  opts: JiraClientOptions,
  attachment: Attachment,
): Promise<Buffer> {
  return (await request(opts, "GET", attachment.content, {
    responseType: "buffer",
  })) as Buffer;
}

export async function getTransitions(
  opts: JiraClientOptions,
  key: string,
): Promise<Transition[]> {
  const json = await request(
    opts,
    "GET",
    `/issue/${encodeURIComponent(key)}/transitions`,
  );
  return TransitionsResponseSchema.parse(json).transitions;
}

export async function transitionIssue(
  opts: JiraClientOptions,
  key: string,
  transitionId: string,
): Promise<void> {
  await request(opts, "POST", `/issue/${encodeURIComponent(key)}/transitions`, {
    body: { transition: { id: transitionId } },
    parseJson: false,
  });
}

export async function findUserByEmail(
  opts: JiraClientOptions,
  email: string,
): Promise<User> {
  const json = await request(
    opts,
    "GET",
    `/user/search?query=${encodeURIComponent(email)}`,
  );
  const users = UserSearchResponseSchema.parse(json);
  if (users.length === 0) {
    throw new Error(`Aucun utilisateur Jira trouvé pour "${email}".`);
  }
  return users[0];
}

export async function getMyself(opts: JiraClientOptions): Promise<User> {
  const json = await request(opts, "GET", "/myself");
  return UserSchema.parse(json);
}

// Liste les boards Agile associés à un projet (API Agile).
export async function getBoardsForProject(
  opts: JiraClientOptions,
  projectKeyOrId: string,
): Promise<Board[]> {
  const json = await request(
    opts,
    "GET",
    `/board?projectKeyOrId=${encodeURIComponent(projectKeyOrId)}&maxResults=50`,
    { root: "agile" },
  );
  return BoardsResponseSchema.parse(json).values;
}

export async function getBoardSprints(
  opts: JiraClientOptions,
  boardId: string,
): Promise<Sprint[]> {
  const json = await request(
    opts,
    "GET",
    `/board/${encodeURIComponent(boardId)}/sprint?state=active,future&maxResults=50`,
    { root: "agile" },
  );
  return BoardSprintsResponseSchema.parse(json).values;
}

export async function addIssueToSprint(
  opts: JiraClientOptions,
  sprintId: number,
  key: string,
): Promise<void> {
  await request(opts, "POST", `/sprint/${sprintId}/issue`, {
    body: { issues: [key] },
    root: "agile",
    parseJson: false,
  });
}
