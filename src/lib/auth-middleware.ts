import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { member } from "../db/auth-schema";
import { auth } from "./auth";

/**
 * Roles do plugin organization do Better Auth.
 * - owner: criador, pode tudo (inclusive deletar a org)
 * - admin: pode gerenciar membros e recursos
 * - member: leitura + disparar runs
 */
export const orgRoles = ["owner", "admin", "member"] as const;
export type OrgRole = (typeof orgRoles)[number];

/**
 * Plugin Elysia que injeta `session` e `user` no contexto.
 * Use `.use(authPlugin)` em routers que precisam de autenticação.
 */
export const authPlugin = new Elysia({ name: "auth" }).derive(
  { as: "scoped" },
  async ({ request, status }) => {
    const result = await auth.api.getSession({ headers: request.headers });
    if (!result) throw status(401, { error: "unauthorized" });
    return { session: result.session, user: result.user };
  },
);

/**
 * Plugin que, além de exigir auth, garante que a sessão tenha uma organização ativa
 * e que o usuário seja membro dela. Expõe `organizationId` e o `role` do membro.
 */
export const requireOrganization = new Elysia({ name: "require-organization" }).derive(
  { as: "scoped" },
  async ({ request, status }) => {
    const result = await auth.api.getSession({ headers: request.headers });
    if (!result) throw status(401, { error: "unauthorized" });
    const organizationId = result.session.activeOrganizationId;
    if (!organizationId) throw status(403, { error: "no_active_organization" });

    // Busca o membership pra obter o role. Se mudaram o user de org sem
    // refazer signin, o membership some daqui — bloqueamos.
    const [m] = await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, result.user.id)))
      .limit(1);
    if (!m) throw status(403, { error: "not_a_member" });

    return {
      session: result.session,
      user: result.user,
      organizationId,
      role: m.role as OrgRole,
    };
  },
);

/**
 * Helper pra `beforeHandle` em endpoints destrutivos. Precisa rodar dentro
 * de um router que já passou por `requireOrganization` (que popula `role`).
 *
 * Uso:
 *   .post("/", handler, { beforeHandle: requireRole("owner", "admin"), body: ... })
 *
 * Tipamos só o que consumimos do contexto; o Elysia passa o contexto inteiro
 * mas o destructuring restringe ao que precisamos.
 */
type StatusFn = (code: number, body: unknown) => unknown;

export function requireRole(...allowed: OrgRole[]) {
  return ({ role, status }: { role: OrgRole; status: StatusFn }) => {
    if (!allowed.includes(role)) {
      return status(403, { error: "forbidden", required: allowed });
    }
    return undefined;
  };
}
