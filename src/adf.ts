import type { AdfNode } from "./jira.schemas.js";

// ── Markdown → ADF ────────────────────────────────────────────────────────────

// Retire une paire de guillemets (simples ou doubles) encadrant une valeur.
function unquote(value: string): string {
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value[value.length - 1] === q) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// Extrait les paires clé/valeur du frontmatter YAML (valeurs scalaires uniquement).
// Retourne un objet vide si le texte ne commence pas par ---.
export function parseFrontmatter(text: string): Record<string, string> {
  const s = text.replace(/\r\n/g, "\n");
  if (!s.startsWith("---\n")) return {};
  const end = s.indexOf("\n---\n", 4);
  if (end === -1) return {};
  const result: Record<string, string> = {};
  for (const line of s.slice(4, end).split("\n")) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)/);
    if (m) result[m[1]] = unquote(m[2].trim());
  }
  return result;
}

// Supprime le bloc de frontmatter YAML (--- … ---) en tête de fichier.
export function stripFrontmatter(text: string): string {
  const s = text.replace(/\r\n/g, "\n");
  if (!s.startsWith("---\n")) return s;
  const end = s.indexOf("\n---\n", 4);
  if (end === -1) return s;
  return s.slice(end + 5).trimStart();
}

// Regex inline : code, gras, italique, lien (testée dans cet ordre).
const INLINE_RE =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[([^\]]+)\]\(([^)]+)\))/g;

function parseInline(text: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  let lastIndex = 0;
  INLINE_RE.lastIndex = 0;
  let match = INLINE_RE.exec(text);

  while (match !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push({
        type: "text",
        text: token.slice(1, -1),
        marks: [{ type: "code" }],
      });
    } else if (token.startsWith("**")) {
      nodes.push({
        type: "text",
        text: token.slice(2, -2),
        marks: [{ type: "strong" }],
      });
    } else if (token.startsWith("*")) {
      nodes.push({
        type: "text",
        text: token.slice(1, -1),
        marks: [{ type: "em" }],
      });
    } else {
      // Lien [texte](url)
      nodes.push({
        type: "text",
        text: match[2],
        marks: [{ type: "link", attrs: { href: match[3] } }],
      });
    }
    lastIndex = match.index + token.length;
    match = INLINE_RE.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push({ type: "text", text: text.slice(lastIndex) });
  }
  return nodes.filter((n) => n.type !== "text" || (n.text ?? "") !== "");
}

function parseMarkdownBlocks(text: string): AdfNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: AdfNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Bloc de code fencé ```lang
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // fermeture ```
      const codeText = codeLines.join("\n");
      blocks.push({
        type: "codeBlock",
        attrs: lang ? { language: lang } : {},
        content: codeText ? [{ type: "text", text: codeText }] : [],
      });
      continue;
    }

    // Titre # … ######
    const hMatch = line.match(/^(#{1,6}) (.+)/);
    if (hMatch) {
      blocks.push({
        type: "heading",
        attrs: { level: hMatch[1].length },
        content: parseInline(hMatch[2].trim()),
      });
      i++;
      continue;
    }

    // Règle horizontale (--- *** ___)
    if (/^[-*_]{3,}\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    // Blockquote >
    if (line.startsWith("> ") || line === ">") {
      const qLines: string[] = [];
      while (
        i < lines.length &&
        (lines[i].startsWith("> ") || lines[i] === ">")
      ) {
        qLines.push(lines[i].startsWith("> ") ? lines[i].slice(2) : "");
        i++;
      }
      blocks.push({
        type: "blockquote",
        content: parseMarkdownBlocks(qLines.join("\n")),
      });
      continue;
    }

    // Liste à puces
    if (/^[-*+] /.test(line)) {
      const items: AdfNode[] = [];
      while (i < lines.length && /^[-*+] /.test(lines[i])) {
        const head = lines[i].replace(/^[-*+] /, "");
        i++;
        const parts = [head];
        // Lignes de continuation indentées (2+ espaces)
        while (i < lines.length && /^ {2}/.test(lines[i])) {
          parts.push(lines[i].trim());
          i++;
        }
        items.push({
          type: "listItem",
          content: [
            { type: "paragraph", content: parseInline(parts.join(" ")) },
          ],
        });
      }
      blocks.push({ type: "bulletList", content: items });
      continue;
    }

    // Liste numérotée
    if (/^\d+\. /.test(line)) {
      const items: AdfNode[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        const head = lines[i].replace(/^\d+\. /, "");
        i++;
        const parts = [head];
        while (i < lines.length && /^ {2}/.test(lines[i])) {
          parts.push(lines[i].trim());
          i++;
        }
        items.push({
          type: "listItem",
          content: [
            { type: "paragraph", content: parseInline(parts.join(" ")) },
          ],
        });
      }
      blocks.push({ type: "orderedList", content: items });
      continue;
    }

    // Paragraphe : lignes consécutives jusqu'au prochain bloc ou ligne vide.
    const paraLines: string[] = [];
    while (i < lines.length) {
      const pl = lines[i];
      if (pl.trim() === "") break;
      if (/^#{1,6} /.test(pl)) break;
      if (pl.startsWith("```")) break;
      if (/^[-*+] /.test(pl)) break;
      if (/^\d+\. /.test(pl)) break;
      if (/^[-*_]{3,}\s*$/.test(pl)) break;
      if (pl.startsWith("> ") || pl === ">") break;
      paraLines.push(pl);
      i++;
    }
    if (paraLines.length > 0) {
      // Soft-wrap Markdown : les lignes d'un même paragraphe sont jointes par un espace.
      const joined = paraLines.map((l) => l.trim()).join(" ");
      const inline = parseInline(joined);
      if (inline.length > 0) {
        blocks.push({ type: "paragraph", content: inline });
      }
    }
  }

  return blocks;
}

// Convertit du Markdown (CommonMark simplifié) en ADF.
// Éléments reconnus : frontmatter YAML (stripé), titres H1–H6, paragraphes,
// gras (**), italique (*), code inline (`), blocs de code fencés, listes à
// puces et numérotées avec continuation, blockquotes, règles horizontales,
// liens [texte](url).
export function markdownToAdf(markdown: string): AdfNode {
  const body = stripFrontmatter(markdown);
  return { type: "doc", version: 1, content: parseMarkdownBlocks(body) };
}

// Convertit un nœud ADF (ou un texte brut, ou null/undefined) en texte lisible.
// Formatage minimal pour affichage terminal : titres avec #, listes avec •.
export function adfToText(node: AdfNode | string | null | undefined): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  return visitAdfNode(node).trim();
}

function visitAdfListItem(item: AdfNode): string {
  return (item.content ?? [])
    .map((child) => {
      if (child.type === "bulletList") {
        return (child.content ?? [])
          .map((sub) => `  • ${visitAdfListItem(sub)}`)
          .join("\n");
      }
      if (child.type === "orderedList") {
        return (child.content ?? [])
          .map((sub, i) => `  ${i + 1}. ${visitAdfListItem(sub)}`)
          .join("\n");
      }
      return visitAdfNode(child);
    })
    .join("")
    .trim();
}

function visitAdfNode(node: AdfNode): string {
  switch (node.type) {
    case "doc":
      return (node.content ?? [])
        .map(visitAdfNode)
        .filter(Boolean)
        .join("\n\n");
    case "paragraph":
      return (node.content ?? []).map(visitAdfNode).join("");
    case "text":
      return node.text ?? "";
    case "hardBreak":
      return "\n";
    case "heading": {
      const level = Math.min((node.attrs?.level as number) ?? 1, 6);
      const text = (node.content ?? []).map(visitAdfNode).join("");
      return `${"#".repeat(level)} ${text}`;
    }
    case "bulletList":
      return (node.content ?? [])
        .map((item) => `• ${visitAdfListItem(item)}`)
        .join("\n");
    case "orderedList":
      return (node.content ?? [])
        .map((item, i) => `${i + 1}. ${visitAdfListItem(item)}`)
        .join("\n");
    case "listItem":
      return visitAdfListItem(node);
    case "codeBlock": {
      const lang = (node.attrs?.language as string) ?? "";
      const code = (node.content ?? []).map(visitAdfNode).join("");
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }
    case "blockquote":
      return (node.content ?? [])
        .map(visitAdfNode)
        .join("\n")
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "rule":
      return "---";
    case "mention":
      return `@${(node.attrs?.text as string) ?? (node.attrs?.id as string) ?? "?"}`;
    case "emoji":
      return (
        (node.attrs?.text as string) ?? (node.attrs?.shortName as string) ?? ""
      );
    case "inlineCard":
    case "blockCard":
      return (node.attrs?.url as string) ?? "";
    case "mediaSingle":
    case "media":
      return "";
    default:
      return (node.content ?? []).map(visitAdfNode).join("");
  }
}

// Convertit du texte brut en Atlassian Document Format (ADF), requis par
// l'API Jira v3 pour le champ `description`.
//
// Règles de conversion :
//   - une ligne vide sépare deux paragraphes ;
//   - un simple retour à la ligne devient un saut de ligne (hardBreak).
//
// Le formatage riche (gras, listes, liens…) n'est pas interprété : le texte
// est rendu tel quel. Suffisant pour des descriptions de fiches.
export function textToAdf(text: string): AdfNode {
  const normalized = text.replace(/\r\n/g, "\n").trimEnd();
  const paragraphs = normalized.split(/\n\s*\n/);

  const content: AdfNode[] = paragraphs.map((paragraph) => {
    const lines = paragraph.split("\n");
    const inline: AdfNode[] = [];
    lines.forEach((line, index) => {
      if (index > 0) inline.push({ type: "hardBreak" });
      if (line.length > 0) inline.push({ type: "text", text: line });
    });
    // Un nœud `text` vide est invalide en ADF : on omet `content` si rien.
    return inline.length > 0
      ? { type: "paragraph", content: inline }
      : { type: "paragraph" };
  });

  return { type: "doc", version: 1, content };
}
