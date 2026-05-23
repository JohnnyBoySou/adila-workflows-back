import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { env } from "../config/env";
import { db } from "../db";
import * as authSchema from "../db/auth-schema";

const trustedOrigins = env.CORS_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Slug derivado do e-mail + sufixo aleatório curto pra evitar colisões.
 * O slug é único no banco (unique constraint), então o sufixo blinda contra
 * dois usuários com a mesma parte local do e-mail.
 */
function buildOrgSlug(email: string): string {
  const local =
    (email.split("@")[0] ?? "user")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "user";
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${local}-${suffix}`;
}

/**
 * Garante que o usuário tenha uma organização padrão (e seja owner dela).
 * Idempotente: se já houver `member`, não faz nada.
 *
 * Exportado pra que o seed possa também usar — assim users criados antes
 * deste hook conseguem ser backfillados sem duplicar código.
 */
export async function ensureUserOrganization(opts: {
  userId: string;
  email: string;
  name: string;
}): Promise<string> {
  const [existing] = await db
    .select({ orgId: authSchema.member.organizationId })
    .from(authSchema.member)
    .where(eq(authSchema.member.userId, opts.userId))
    .limit(1);
  if (existing) return existing.orgId;

  const orgId = crypto.randomUUID();
  await db.insert(authSchema.organization).values({
    id: orgId,
    name: `${opts.name}'s Workspace`,
    slug: buildOrgSlug(opts.email),
    createdAt: new Date(),
  });
  await db.insert(authSchema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: opts.userId,
    role: "owner",
    createdAt: new Date(),
  });
  return orgId;
}

// `BETTER_AUTH_SECRET` é opcional em env.ts pra permitir que o worker rode
// sem essa variável (ele nunca importa este módulo). Aqui, no boot do HTTP
// server, exigimos explicitamente — falha cedo com mensagem clara.
if (!env.BETTER_AUTH_SECRET) {
  throw new Error(
    "BETTER_AUTH_SECRET é obrigatório no servidor HTTP — defina a env var antes de subir o serviço.",
  );
}

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // Origens confiáveis para CSRF / redirects. Front em dev (Vite) entra aqui.
  trustedOrigins,

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
  }),

  emailAndPassword: {
    enabled: true,
  },

  databaseHooks: {
    // Toda conta nova ganha uma organização própria (owner) — o app exige
    // organização ativa pra acessar rotas de domínio.
    user: {
      create: {
        after: async (user) => {
          await ensureUserOrganization({
            userId: user.id,
            email: user.email,
            name: user.name,
          });
        },
      },
    },
    // Ao criar uma sessão, embarcamos a primeira organização do user como
    // ativa. Cobre login após signup e logins subsequentes.
    session: {
      create: {
        before: async (session) => {
          const [m] = await db
            .select({ orgId: authSchema.member.organizationId })
            .from(authSchema.member)
            .where(eq(authSchema.member.userId, session.userId))
            .limit(1);
          return {
            data: {
              ...session,
              activeOrganizationId: m?.orgId ?? null,
            },
          };
        },
      },
    },
  },

  advanced: {
    // Front e back em origens distintas em dev (Vite 5173 ↔ Elysia 3000):
    // SameSite=None + Secure é o único combo que faz o cookie viajar em fetch
    // cross-origin com credentials. Browsers aceitam Secure em http://localhost.
    // Em prod, prefira hospedar back/front em subdomínios do mesmo eTLD+1 e
    // habilite crossSubDomainCookies pra trocar pra SameSite=Lax.
    defaultCookieAttributes: {
      sameSite: "none",
      secure: true,
    },
  },

  plugins: [
    organization({
      // Permite a criação de várias organizações por usuário.
      allowUserToCreateOrganization: true,
      // Convites por e-mail expiram em 48h por padrão.
      invitationExpiresIn: 60 * 60 * 48,
    }),
  ],
});

export type Auth = typeof auth;
export type Session = typeof auth.$Infer.Session;
