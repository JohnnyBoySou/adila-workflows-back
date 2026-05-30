import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// Validação das variáveis de ambiente com TypeBox.
const EnvSchema = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal("development"), Type.Literal("production"), Type.Literal("test")],
    { default: "development" },
  ),
  PORT: Type.Number({ default: 3000 }),

  // Nível do logger (pino). trace/debug/info/warn/error/fatal/silent.
  LOG_LEVEL: Type.Union(
    [
      Type.Literal("trace"),
      Type.Literal("debug"),
      Type.Literal("info"),
      Type.Literal("warn"),
      Type.Literal("error"),
      Type.Literal("fatal"),
      Type.Literal("silent"),
    ],
    { default: "info" },
  ),

  DATABASE_URL: Type.String({ minLength: 1 }),

  REDIS_URL: Type.String({ default: "redis://127.0.0.1:6379" }),
  WORKFLOW_WORKER_CONCURRENCY: Type.Number({ default: 20 }),

  // Obrigatório no servidor HTTP; o worker não carrega `lib/auth` e por
  // isso roda sem essa variável. A checagem dura mora em `lib/auth.ts`.
  BETTER_AUTH_SECRET: Type.Optional(Type.String({ minLength: 1 })),
  BETTER_AUTH_URL: Type.String({ default: "http://localhost:3000" }),

  // Domínio para cookies cross-subdomain (ex.: ".workflow.lai.ia.br").
  // Quando setado, o cookie de sessão é emitido com Domain=<valor>, fazendo
  // o browser enviar a sessão para *.workflow.lai.ia.br — necessário para
  // o serviço realtime em `realtime.workflow.lai.ia.br` reconhecer a sessão
  // emitida por `api.workflow.lai.ia.br`. Não setar em dev.
  AUTH_COOKIE_DOMAIN: Type.Optional(Type.String({ minLength: 1 })),

  // Chave simétrica para AES-256-GCM (criptografia de secrets em repouso).
  // 32 bytes em base64. Gere com: openssl rand -base64 32
  ENCRYPTION_KEY: Type.String({ minLength: 1 }),

  // Origens permitidas para CORS + trustedOrigins do Better Auth.
  // Aceita uma lista separada por vírgula. Em dev, default cobre o Vite (5173).
  CORS_ORIGINS: Type.String({ default: "http://localhost:5173" }),

  // URL pública do front (links em e-mails). Se omitido, usa a primeira origem de CORS_ORIGINS.
  FRONTEND_URL: Type.Optional(Type.String({ minLength: 1 })),

  // SMTP (Nodemailer) — convites de organização. Se SMTP_HOST estiver vazio, e-mails não são enviados.
  SMTP_HOST: Type.Optional(Type.String({ minLength: 1 })),
  SMTP_PORT: Type.Optional(Type.Number({ default: 465 })),
  SMTP_USER: Type.Optional(Type.String({ minLength: 1 })),
  SMTP_PASS: Type.Optional(Type.String({ minLength: 1 })),
  SMTP_FROM: Type.Optional(Type.String({ minLength: 1 })),

  ANTHROPIC_API_KEY: Type.Optional(Type.String()),
  OPENAI_API_KEY: Type.Optional(Type.String()),

  // Delay mínimo entre nós executados, em ms. Útil em dev/demo pra que a
  // animação no front consiga acompanhar cada nó individualmente — sem
  // isso, steps de 1-10ms passam imperceptíveis na UI. Em prod = 0.
  STEP_MIN_DELAY_MS: Type.Number({ default: 0 }),
});

// Aplica defaults → converte tipos (string → number/boolean) → valida → decode.
const withDefaults = Value.Default(EnvSchema, { ...process.env });
const converted = Value.Convert(EnvSchema, withDefaults);

if (!Value.Check(EnvSchema, converted)) {
  const errors = [...Value.Errors(EnvSchema, converted)]
    .map((e) => `  ${e.path || "/"}: ${e.message}`)
    .join("\n");
  throw new Error(`Variáveis de ambiente inválidas:\n${errors}`);
}

export const env = Value.Decode(EnvSchema, converted);
