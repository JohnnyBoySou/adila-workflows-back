-- Adiciona coluna `config` (JSONB) em `triggers` para armazenar configuração
-- por tipo (interval: every/unit, email: IMAP creds, rss: url+lastSeen, etc).
-- Coluna `type` continua `text` com narrowing TS — nenhum ALTER TYPE necessário.
ALTER TABLE "triggers"
ADD COLUMN IF NOT EXISTS "config" jsonb NOT NULL DEFAULT '{}'::jsonb;
