-- Coluna `input_schema` foi adicionada ao schema (src/db/schema.ts) sem
-- gerar migration correspondente. Reaplica idempotente.
ALTER TABLE "triggers" ADD COLUMN IF NOT EXISTS "input_schema" jsonb;
