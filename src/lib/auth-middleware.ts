import { Elysia } from "elysia";
import { authenticateRequest, IdentityAuthError, localMemberRole } from "./identity-auth";

/**
 * Roles do plugin organization do Better Auth (espelhados do Identity).
 * - owner: criador, pode tudo (inclusive deletar a org)
 * - admin: pode gerenciar membros e recursos
 * - member: leitura + disparar runs
 */
export const orgRoles = ["owner", "admin", "member"] as const;
export type OrgRole = (typeof orgRoles)[number];

/**
 * Forma mínima da sessão/usuário injetada no contexto. A auth é federada no
 * Identity (JWT), então não há mais uma sessão local do Better Auth — expomos
 * só o que os routers consomem: id do usuário e a org ativa.
 */
export interface RequestUser {
  id: string;
  email: string;
  name: string;
}
export interface RequestSession {
  userId: string;
  activeOrganizationId: string | null;
}

/**
 * Plugin Elysia que injeta `session` e `user` no contexto verificando o JWT do
 * Identity (`Authorization: Bearer`). Use `.use(authPlugin)` em routers que
 * precisam de autenticação.
 */
export const authPlugin = new Elysia({ name: "auth" }).derive(
  { as: "scoped" },
  async ({ request, status }) => {
    try {
      const claims = await authenticateRequest(request.headers);
      const user: RequestUser = { id: claims.userId, email: claims.email, name: claims.name };
      const session: RequestSession = {
        userId: claims.userId,
        activeOrganizationId: claims.organizationId,
      };
      return { session, user };
    } catch (error) {
      if (error instanceof IdentityAuthError) throw status(401, { error: "unauthorized" });
      throw error;
    }
  },
);

/**
 * Além de exigir auth, garante que o token traga uma organização ativa e que o
 * usuário seja membro dela (espelhado localmente). Expõe `organizationId` e o
 * `role` do membro.
 */
export const requireOrganization = new Elysia({ name: "require-organization" }).derive(
  { as: "scoped" },
  async ({ request, status }) => {
    let claims;
    try {
      claims = await authenticateRequest(request.headers);
    } catch (error) {
      if (error instanceof IdentityAuthError) throw status(401, { error: "unauthorized" });
      throw error;
    }

    const organizationId = claims.organizationId;
    if (!organizationId) throw status(403, { error: "no_active_organization" });

    // O papel vem do token (espelhado no provisioning). Fallback: relê do banco
    // local caso o token não traga o role mas a membership exista.
    const role = claims.organizationRole ?? (await localMemberRole(organizationId, claims.userId));
    if (!role) throw status(403, { error: "not_a_member" });

    const user: RequestUser = { id: claims.userId, email: claims.email, name: claims.name };
    const session: RequestSession = { userId: claims.userId, activeOrganizationId: organizationId };

    return {
      session,
      user,
      organizationId,
      role: role as OrgRole,
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
