import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Schema de identidade — espelho local do Identity (adila.co).
 *
 * A auth é federada: o back não é provedor de identidade (Better Auth foi
 * removido). Estas tabelas apenas lastreiam as foreign keys de tenancy —
 * `user`/`organization`/`member` são preenchidas via provisioning JIT em
 * `lib/identity-auth.ts` a partir do JWT do Identity.
 *
 * As tabelas `session`/`account`/`verification`/`invitation` (herança do
 * Better Auth) foram removidas — a migration de drop acompanha esta mudança.
 */

// ────────────────────────── core ──────────────────────────

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ──────────────────────── organization ────────────────────────

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const member = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
