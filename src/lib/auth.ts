import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { env } from "../config/env";
import { db } from "../db";
import * as authSchema from "../db/auth-schema";

const trustedOrigins = env.CORS_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

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
