import type { AdfNode } from "./jira.schemas.js";

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
