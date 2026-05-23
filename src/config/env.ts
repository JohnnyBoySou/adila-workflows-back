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

  // Obrigatório no servidor HTTP; o worker não carrega `lib/auth` e por
  // isso roda sem essa variável. A checagem dura mora em `lib/auth.ts`.
  BETTER_AUTH_SECRET: Type.Optional(Type.String({ minLength: 1 })),
  BETTER_AUTH_URL: Type.String({ default: "http://localhost:3000" }),

  // Chave simétrica para AES-256-GCM (criptografia de secrets em repouso).
  // 32 bytes em base64. Gere com: openssl rand -base64 32
  ENCRYPTION_KEY: Type.String({ minLength: 1 }),

  // Origens permitidas para CORS + trustedOrigins do Better Auth.
  // Aceita uma lista separada por vírgula. Em dev, default cobre o Vite (5173).
  CORS_ORIGINS: Type.String({ default: "http://localhost:5173" }),

  ANTHROPIC_API_KEY: Type.Optional(Type.String()),
  OPENAI_API_KEY: Type.Optional(Type.String()),
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
