import { z } from "zod";

export const SprintSchema = z.object({
  id: z.number(),
  name: z.string(),
  state: z.enum(["active", "closed", "future"]),
});

export type Sprint = z.infer<typeof SprintSchema>;

// ADF = Atlassian Document Format. Nœud récursif, structure ouverte.
export const AdfNodeSchema: z.ZodType<AdfNode> = z.lazy(() =>
  z
    .object({
      type: z.string(),
      text: z.string().optional(),
      content: z.array(AdfNodeSchema).optional(),
      attrs: z.record(z.any()).optional(),
      marks: z.array(z.any()).optional(),
    })
    .passthrough(),
);

export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: unknown[];
  [key: string]: unknown;
}

// Réponse de POST /issue (création).
export const CreateIssueResponseSchema = z.object({
  id: z.string(),
  key: z.string(),
  self: z.string(),
});

export type CreateIssueResponse = z.infer<typeof CreateIssueResponseSchema>;

// Transitions disponibles pour une issue.
export const TransitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  to: z.object({ name: z.string() }).optional(),
});

export type Transition = z.infer<typeof TransitionSchema>;

export const TransitionsResponseSchema = z.object({
  transitions: z.array(TransitionSchema),
});

// Utilisateur Jira (recherche ou /myself).
export const UserSchema = z
  .object({
    accountId: z.string(),
    displayName: z.string().optional(),
    emailAddress: z.string().optional(),
  })
  .passthrough();

export type User = z.infer<typeof UserSchema>;

export const UserSearchResponseSchema = z.array(UserSchema);

// Liste des sprints d'un board (API Agile).
export const BoardSprintsResponseSchema = z.object({
  values: z.array(SprintSchema),
});

// Board Agile (scrum/kanban), associé à un ou plusieurs projets.
export const BoardSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    type: z.string(),
  })
  .passthrough();

export type Board = z.infer<typeof BoardSchema>;

export const BoardsResponseSchema = z.object({
  values: z.array(BoardSchema),
});

// Pièce jointe d'une issue (champ `attachment`, ou réponse d'upload).
export const AttachmentSchema = z
  .object({
    id: z.coerce.string(),
    filename: z.string(),
    size: z.number(),
    mimeType: z.string().optional(),
    content: z.string(), // URL de téléchargement du contenu binaire
  })
  .passthrough();

export type Attachment = z.infer<typeof AttachmentSchema>;

// Réponse de POST /issue/{key}/attachments : tableau des PJ créées.
export const AttachmentsResponseSchema = z.array(AttachmentSchema);

// Issue restreinte au champ `attachment` (GET /issue/{key}?fields=attachment).
export const IssueAttachmentsSchema = z.object({
  fields: z.object({
    attachment: z.array(AttachmentSchema).optional().default([]),
  }),
});

// Réponse de POST /issue/{key}/comment (ajout de commentaire).
export const AddCommentResponseSchema = z
  .object({
    id: z.string(),
    self: z.string(),
  })
  .passthrough();

export type AddCommentResponse = z.infer<typeof AddCommentResponseSchema>;

// ── Sous-schémas pour le détail d'une fiche (non exportés) ───────────────────

const SprintDetailSchema = SprintSchema.passthrough();

const SubtaskRefSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    fields: z
      .object({
        summary: z.string().optional(),
        status: z.object({ name: z.string() }).passthrough().optional(),
        issuetype: z.object({ name: z.string() }).passthrough().optional(),
        priority: z
          .object({ name: z.string() })
          .passthrough()
          .optional()
          .nullable(),
      })
      .passthrough(),
  })
  .passthrough();

const IssueLinkRefSchema = z
  .object({
    id: z.string(),
    type: z
      .object({
        name: z.string(),
        inward: z.string().optional(),
        outward: z.string().optional(),
      })
      .passthrough(),
    inwardIssue: z
      .object({
        key: z.string(),
        fields: z
          .object({
            summary: z.string().optional(),
            status: z.object({ name: z.string() }).passthrough().optional(),
          })
          .passthrough(),
      })
      .passthrough()
      .optional(),
    outwardIssue: z
      .object({
        key: z.string(),
        fields: z
          .object({
            summary: z.string().optional(),
            status: z.object({ name: z.string() }).passthrough().optional(),
          })
          .passthrough(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const IssueCommentItemSchema = z
  .object({
    id: z.string(),
    body: z.union([AdfNodeSchema, z.string()]).optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
    author: z
      .object({
        accountId: z.string(),
        displayName: z.string().optional(),
        emailAddress: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ── Détail complet d'une fiche (commande `get`) ───────────────────────────────

export const IssueDetailSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    fields: z
      .object({
        summary: z.string(),
        description: z.union([AdfNodeSchema, z.null()]).optional(),
        status: z.object({ name: z.string() }).passthrough(),
        issuetype: z.object({ name: z.string() }).passthrough(),
        priority: z
          .object({ name: z.string() })
          .passthrough()
          .optional()
          .nullable(),
        assignee: z
          .object({
            accountId: z.string(),
            displayName: z.string().optional(),
            emailAddress: z.string().optional(),
          })
          .passthrough()
          .optional()
          .nullable(),
        reporter: z
          .object({
            accountId: z.string(),
            displayName: z.string().optional(),
            emailAddress: z.string().optional(),
          })
          .passthrough()
          .optional()
          .nullable(),
        parent: z
          .object({
            id: z.string(),
            key: z.string(),
            fields: z
              .object({
                summary: z.string().optional(),
                issuetype: z
                  .object({ name: z.string() })
                  .passthrough()
                  .optional(),
                status: z.object({ name: z.string() }).passthrough().optional(),
                priority: z
                  .object({ name: z.string() })
                  .passthrough()
                  .optional()
                  .nullable(),
              })
              .passthrough(),
          })
          .passthrough()
          .optional()
          .nullable(),
        subtasks: z.array(SubtaskRefSchema).optional().default([]),
        issuelinks: z.array(IssueLinkRefSchema).optional().default([]),
        comment: z
          .object({
            comments: z.array(IssueCommentItemSchema),
            total: z.number().optional(),
          })
          .passthrough()
          .optional(),
        attachment: z.array(AttachmentSchema).optional().default([]),
        created: z.string().optional(),
        updated: z.string().optional(),
        customfield_10020: z.array(SprintDetailSchema).optional().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

export type IssueDetail = z.infer<typeof IssueDetailSchema>;

// ── Recherche JQL (enfants d'une fiche : `parent = KEY`) ─────────────────────

const ChildIssueSchema = z
  .object({
    key: z.string(),
    fields: z
      .object({
        summary: z.string().optional(),
        status: z.object({ name: z.string() }).passthrough().optional(),
        issuetype: z.object({ name: z.string() }).passthrough().optional(),
        priority: z
          .object({ name: z.string() })
          .passthrough()
          .optional()
          .nullable(),
      })
      .passthrough(),
  })
  .passthrough();

export const SearchResponseSchema = z
  .object({
    issues: z.array(ChildIssueSchema).optional().default([]),
  })
  .passthrough();

export type ChildIssue = z.infer<typeof ChildIssueSchema>;
