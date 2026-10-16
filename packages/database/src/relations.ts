import { relations } from "drizzle-orm";

import { users, walletIdentities, sessions, roleGrants } from "./schema/auth.js";
import {
  subjects,
  dossierVersions,
  dossierDrafts,
  publicationReceipts,
  claims,
  claimEvidence,
} from "./schema/core.js";
import { watchlists, watchlistItems, homeEditions, featuredItems } from "./schema/engagement.js";
import {
  paymentIntents,
  paymentAttempts,
  verifiedTransfers,
  refunds,
} from "./schema/payments.js";
import { researchRuns, researchSteps, modelCalls } from "./schema/research.js";

/**
 * Relations for drizzle-orm's relational query builder. These are included
 * in the schema object so API/worker lanes can eager-load without
 * hand-writing joins. Business rules still live in packages/* services.
 */

export const subjectsRelations = relations(subjects, ({ many, one }) => ({
  versions: many(dossierVersions),
  drafts: many(dossierDrafts),
  currentPublishedVersion: one(dossierVersions, {
    fields: [subjects.currentPublishedVersionId],
    references: [dossierVersions.id],
  }),
}));

export const dossierVersionsRelations = relations(
  dossierVersions,
  ({ one }) => ({
    subject: one(subjects, {
      fields: [dossierVersions.subjectId],
      references: [subjects.id],
    }),
    receipt: one(publicationReceipts, {
      fields: [dossierVersions.id],
      references: [publicationReceipts.versionId],
    }),
  }),
);

export const publicationReceiptsRelations = relations(
  publicationReceipts,
  ({ one }) => ({
    version: one(dossierVersions, {
      fields: [publicationReceipts.versionId],
      references: [dossierVersions.id],
    }),
  }),
);

export const claimsRelations = relations(claims, ({ many }) => ({
  evidence: many(claimEvidence),
}));

export const usersRelations = relations(users, ({ many }) => ({
  walletIdentities: many(walletIdentities),
  sessions: many(sessions),
  roleGrants: many(roleGrants),
}));

export const researchRunsRelations = relations(researchRuns, ({ many }) => ({
  steps: many(researchSteps),
  modelCalls: many(modelCalls),
}));

export const paymentIntentsRelations = relations(paymentIntents, ({ many }) => ({
  attempts: many(paymentAttempts),
  verifiedTransfers: many(verifiedTransfers),
  refunds: many(refunds),
}));

export const watchlistsRelations = relations(watchlists, ({ many }) => ({
  items: many(watchlistItems),
}));

export const homeEditionsRelations = relations(homeEditions, ({ many }) => ({
  featuredItems: many(featuredItems),
}));
