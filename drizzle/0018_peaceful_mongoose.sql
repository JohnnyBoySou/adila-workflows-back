-- `triggers.config` já é adicionada pela 0017_extended_triggers (que roda antes
-- desta na ordem do journal). Esta migration era um duplicado não-idempotente
-- que colidia em bancos novos ("column config already exists"). Tornada
-- idempotente com IF NOT EXISTS: no-op onde a coluna já existe, sem reaplicar
-- em bancos já migrados (o migrator gateia por `when`, não pelo hash do SQL).
ALTER TABLE "triggers" ADD COLUMN IF NOT EXISTS "config" jsonb DEFAULT '{}'::jsonb NOT NULL;
