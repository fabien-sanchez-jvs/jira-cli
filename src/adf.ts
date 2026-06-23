import type { AdfNode } from "./jira.schemas.js";

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
