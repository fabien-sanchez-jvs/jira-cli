import { describe, expect, it } from "vitest";
import { markdownToAdf, stripFrontmatter } from "../src/adf.js";
import type { AdfNode } from "../src/jira.schemas.js";

// ── stripFrontmatter ──────────────────────────────────────────────────────────

describe("stripFrontmatter", () => {
  it("supprime un frontmatter YAML valide", () => {
    const input = "---\ntitle: Mon titre\n---\n\nCorps du document.";
    expect(stripFrontmatter(input)).toBe("Corps du document.");
  });

  it("laisse un texte sans frontmatter inchangé", () => {
    const input = "# Titre\n\nParagraphe.";
    expect(stripFrontmatter(input)).toBe(input);
  });

  it("frontmatter seul → corps vide", () => {
    const input = "---\ntitle: Seul\n---\n";
    expect(stripFrontmatter(input)).toBe("");
  });

  it("frontmatter multi-champs", () => {
    const input = "---\ntitle: T\nassignee: me\ntype: Bug\n---\n\nCorps.";
    expect(stripFrontmatter(input)).toBe("Corps.");
  });

  it("--- au milieu du texte → non interprété comme frontmatter", () => {
    const input = "Intro.\n\n---\n\nSuite.";
    expect(stripFrontmatter(input)).toBe(input);
  });

  it("normalise les fins de ligne CRLF", () => {
    const input = "---\r\ntitle: T\r\n---\r\n\r\nCorps.";
    expect(stripFrontmatter(input)).toBe("Corps.");
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Retourne le premier bloc de content du doc. */
function firstBlock(md: string): AdfNode {
  const doc = markdownToAdf(md);
  const block = doc.content?.[0];
  if (!block) throw new Error("Doc vide");
  return block;
}

/** Retourne le nœud texte inline à l'index donné dans le premier bloc. */
function inlineNode(md: string, index = 0): AdfNode {
  const block = firstBlock(md);
  const node = block.content?.[index];
  if (!node) throw new Error(`Pas de nœud inline[${index}]`);
  return node;
}

// ── markdownToAdf — structure du document ────────────────────────────────────

describe("markdownToAdf — document", () => {
  it("document vide → doc avec content vide", () => {
    const doc = markdownToAdf("");
    expect(doc).toEqual({ type: "doc", version: 1, content: [] });
  });

  it("frontmatter stripé → non inclus dans le doc", () => {
    const doc = markdownToAdf("---\ntitle: T\n---\n\n# Titre");
    expect(doc.content).toHaveLength(1);
    expect(doc.content?.[0].type).toBe("heading");
  });

  it("document uniquement frontmatter → doc vide", () => {
    const doc = markdownToAdf("---\ntitle: T\n---\n");
    expect(doc).toEqual({ type: "doc", version: 1, content: [] });
  });
});

// ── markdownToAdf — blocs ─────────────────────────────────────────────────────

describe("markdownToAdf — blocs", () => {
  it("titre H1", () => {
    const block = firstBlock("# User Story");
    expect(block.type).toBe("heading");
    expect(block.attrs?.level).toBe(1);
    expect(block.content?.[0]).toEqual({ type: "text", text: "User Story" });
  });

  it("titre H2", () => {
    const block = firstBlock("## Sous-titre");
    expect(block.attrs?.level).toBe(2);
  });

  it("titre H6", () => {
    const block = firstBlock("###### Profond");
    expect(block.attrs?.level).toBe(6);
  });

  it("paragraphe simple", () => {
    const block = firstBlock("Bonjour le monde.");
    expect(block.type).toBe("paragraph");
    expect(block.content?.[0]).toEqual({
      type: "text",
      text: "Bonjour le monde.",
    });
  });

  it("deux paragraphes séparés par une ligne vide", () => {
    const doc = markdownToAdf("Premier.\n\nDeuxième.");
    expect(doc.content).toHaveLength(2);
    expect(doc.content?.[0].type).toBe("paragraph");
    expect(doc.content?.[1].type).toBe("paragraph");
  });

  it("lignes soft-wrappées → un seul paragraphe joint par espace", () => {
    const doc = markdownToAdf("Ligne un\nligne deux\nligne trois.");
    expect(doc.content).toHaveLength(1);
    expect(doc.content?.[0].content?.[0]).toEqual({
      type: "text",
      text: "Ligne un ligne deux ligne trois.",
    });
  });

  it("règle horizontale ---", () => {
    const block = firstBlock("---");
    expect(block.type).toBe("rule");
  });

  it("règle horizontale ***", () => {
    const block = firstBlock("***");
    expect(block.type).toBe("rule");
  });

  it("bloc de code avec langage", () => {
    const block = firstBlock("```typescript\nconst x = 1;\n```");
    expect(block.type).toBe("codeBlock");
    expect(block.attrs?.language).toBe("typescript");
    expect(block.content?.[0]).toEqual({
      type: "text",
      text: "const x = 1;",
    });
  });

  it("bloc de code sans langage", () => {
    const block = firstBlock("```\ndu texte\n```");
    expect(block.type).toBe("codeBlock");
    expect(block.attrs?.language).toBeUndefined();
  });

  it("bloc de code vide", () => {
    const block = firstBlock("```\n```");
    expect(block.type).toBe("codeBlock");
    expect(block.content).toEqual([]);
  });

  it("liste à puces", () => {
    const block = firstBlock("- Alpha\n- Bêta\n- Gamma");
    expect(block.type).toBe("bulletList");
    expect(block.content).toHaveLength(3);
    expect(block.content?.[0].type).toBe("listItem");
    expect(block.content?.[0].content?.[0].content?.[0]).toEqual({
      type: "text",
      text: "Alpha",
    });
  });

  it("liste à puces avec *", () => {
    const block = firstBlock("* Item");
    expect(block.type).toBe("bulletList");
  });

  it("liste numérotée", () => {
    const block = firstBlock("1. Premier\n2. Deuxième");
    expect(block.type).toBe("orderedList");
    expect(block.content).toHaveLength(2);
  });

  it("item de liste avec continuation indentée", () => {
    const md = "- Première ligne\n  continuation ici.";
    const block = firstBlock(md);
    expect(block.type).toBe("bulletList");
    const itemText = block.content?.[0].content?.[0].content?.[0] as AdfNode;
    expect(itemText.text).toBe("Première ligne continuation ici.");
  });

  it("blockquote", () => {
    const block = firstBlock("> Citation importante.");
    expect(block.type).toBe("blockquote");
    expect(block.content?.[0].type).toBe("paragraph");
    expect(block.content?.[0].content?.[0]).toEqual({
      type: "text",
      text: "Citation importante.",
    });
  });
});

// ── markdownToAdf — inline ────────────────────────────────────────────────────

describe("markdownToAdf — inline", () => {
  it("texte brut sans marquage", () => {
    const node = inlineNode("Simple texte.");
    expect(node).toEqual({ type: "text", text: "Simple texte." });
  });

  it("gras **texte**", () => {
    const node = inlineNode("**gras**");
    expect(node).toEqual({
      type: "text",
      text: "gras",
      marks: [{ type: "strong" }],
    });
  });

  it("italique *texte*", () => {
    const node = inlineNode("*italique*");
    expect(node).toEqual({
      type: "text",
      text: "italique",
      marks: [{ type: "em" }],
    });
  });

  it("code inline `texte`", () => {
    const node = inlineNode("`monCode`");
    expect(node).toEqual({
      type: "text",
      text: "monCode",
      marks: [{ type: "code" }],
    });
  });

  it("lien [texte](url)", () => {
    const node = inlineNode("[Claude](https://claude.ai)");
    expect(node).toEqual({
      type: "text",
      text: "Claude",
      marks: [{ type: "link", attrs: { href: "https://claude.ai" } }],
    });
  });

  it("mélange texte + gras + code inline", () => {
    const inline = firstBlock("Voir **important** et `code`").content ?? [];
    expect(inline[0]).toEqual({ type: "text", text: "Voir " });
    expect(inline[1]).toEqual({
      type: "text",
      text: "important",
      marks: [{ type: "strong" }],
    });
    expect(inline[2]).toEqual({ type: "text", text: " et " });
    expect(inline[3]).toEqual({
      type: "text",
      text: "code",
      marks: [{ type: "code" }],
    });
  });

  it("code inline avec parens et points (nom de méthode)", () => {
    const node = inlineNode("`PublisherService.replaceMentions()`");
    expect(node).toEqual({
      type: "text",
      text: "PublisherService.replaceMentions()",
      marks: [{ type: "code" }],
    });
  });

  it("gras suivi de deux-points : **Label :**", () => {
    const inline = firstBlock("**Cause racine :** description").content ?? [];
    expect(inline[0]).toEqual({
      type: "text",
      text: "Cause racine :",
      marks: [{ type: "strong" }],
    });
    expect(inline[1]).toEqual({ type: "text", text: " description" });
  });
});

// ── markdownToAdf — intégration (extrait de fiche réelle) ────────────────────

describe("markdownToAdf — intégration", () => {
  const FICHE = `---
title: Bug — identification Facebook disparaît
---

# User Story

**Cause racine :** la regex dans \`replaceMentions()\` ne correspond pas.

# Critère d'acceptation

- Un post contenant \`@Actus Chalons\` produit \`@[PAGE_ID:Actus Chalons]\`.
- Fallback conservé si \`socialContact\` absent.

# Comment

\`\`\`typescript
const mentionRegex = /<span[^>]*class="ql-mention"[^>]*>[^<]*<\\/span>/g;
\`\`\`
`;

  it("le doc contient exactement 4 blocs de haut niveau", () => {
    const doc = markdownToAdf(FICHE);
    // H1 "User Story", paragraphe, H1 "Critère d'acceptation", bulletList, H1 "Comment", codeBlock
    expect(doc.content?.length).toBe(6);
  });

  it("premier bloc = heading H1 'User Story'", () => {
    const doc = markdownToAdf(FICHE);
    const h = doc.content?.[0];
    expect(h?.type).toBe("heading");
    expect(h?.attrs?.level).toBe(1);
    expect(h?.content?.[0]).toEqual({ type: "text", text: "User Story" });
  });

  it("le paragraphe contient gras + code inline", () => {
    const doc = markdownToAdf(FICHE);
    const para = doc.content?.[1];
    expect(para?.type).toBe("paragraph");
    const inline = para?.content ?? [];
    expect(inline.some((n) => n.marks?.some((m: AdfNode) => m.type === "strong"))).toBe(true);
    expect(inline.some((n) => n.marks?.some((m: AdfNode) => m.type === "code"))).toBe(true);
  });

  it("la liste à puces a 2 items", () => {
    const doc = markdownToAdf(FICHE);
    const list = doc.content?.[3];
    expect(list?.type).toBe("bulletList");
    expect(list?.content).toHaveLength(2);
  });

  it("le bloc de code a le langage 'typescript'", () => {
    const doc = markdownToAdf(FICHE);
    const code = doc.content?.[5];
    expect(code?.type).toBe("codeBlock");
    expect(code?.attrs?.language).toBe("typescript");
  });
});
