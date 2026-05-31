import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { decrypt, encrypt } from "../../lib/crypto";
import {
  copilotConversations,
  copilotMessages,
  copilotSettings,
  type CopilotConversation,
  type CopilotMessage,
  type CopilotSettings,
} from "../../db/schema";

/** Patch de upsert de settings. `apiKey` ausente = mantém; `null` = limpa; string = define. */
type SettingsPatch = {
  provider?: string;
  apiKey?: string | null;
  model?: string;
};

export const copilotRepository = {
  // ── Settings (BYOK por organização) ──────────────────────────────────
  async getSettings(organizationId: string): Promise<CopilotSettings | null> {
    const [row] = await db
      .select()
      .from(copilotSettings)
      .where(eq(copilotSettings.organizationId, organizationId))
      .limit(1);
    return row ?? null;
  },

  /** Chave decriptada para uso interno (chamada ao provider). `null` se não configurada. */
  async getApiKey(organizationId: string): Promise<string | null> {
    const row = await this.getSettings(organizationId);
    if (!row?.apiKeyEncrypted) return null;
    return decrypt(row.apiKeyEncrypted);
  },

  async upsertSettings(organizationId: string, patch: SettingsPatch): Promise<CopilotSettings> {
    const apiKeyEncrypted =
      patch.apiKey === undefined
        ? undefined
        : patch.apiKey === null || patch.apiKey === ""
          ? null
          : encrypt(patch.apiKey);

    const [row] = await db
      .insert(copilotSettings)
      .values({
        organizationId,
        provider: patch.provider ?? "openai",
        model: patch.model ?? "gpt-4.1",
        apiKeyEncrypted: apiKeyEncrypted ?? null,
      })
      .onConflictDoUpdate({
        target: copilotSettings.organizationId,
        set: {
          ...(patch.provider !== undefined && { provider: patch.provider }),
          ...(patch.model !== undefined && { model: patch.model }),
          ...(apiKeyEncrypted !== undefined && { apiKeyEncrypted }),
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  },

  // ── Conversas ────────────────────────────────────────────────────────
  async listConversations(
    organizationId: string,
    userId: string,
    workflowId: string | null,
  ): Promise<CopilotConversation[]> {
    return db
      .select()
      .from(copilotConversations)
      .where(
        and(
          eq(copilotConversations.organizationId, organizationId),
          eq(copilotConversations.userId, userId),
          workflowId === null
            ? isNull(copilotConversations.workflowId)
            : eq(copilotConversations.workflowId, workflowId),
        ),
      )
      .orderBy(desc(copilotConversations.updatedAt));
  },

  async getConversation(
    organizationId: string,
    userId: string,
    id: string,
  ): Promise<CopilotConversation | null> {
    const [row] = await db
      .select()
      .from(copilotConversations)
      .where(
        and(
          eq(copilotConversations.id, id),
          eq(copilotConversations.organizationId, organizationId),
          eq(copilotConversations.userId, userId),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async createConversation(data: {
    organizationId: string;
    userId: string;
    workflowId: string | null;
    title: string;
  }): Promise<CopilotConversation> {
    const [row] = await db
      .insert(copilotConversations)
      .values({
        organizationId: data.organizationId,
        userId: data.userId,
        workflowId: data.workflowId,
        title: data.title,
      })
      .returning();
    return row!;
  },

  async renameConversation(id: string, title: string): Promise<CopilotConversation | null> {
    const [row] = await db
      .update(copilotConversations)
      .set({ title, updatedAt: new Date() })
      .where(eq(copilotConversations.id, id))
      .returning();
    return row ?? null;
  },

  async touchConversation(id: string): Promise<void> {
    await db
      .update(copilotConversations)
      .set({ updatedAt: new Date() })
      .where(eq(copilotConversations.id, id));
  },

  async deleteConversation(id: string): Promise<void> {
    await db.delete(copilotConversations).where(eq(copilotConversations.id, id));
  },

  // ── Mensagens ────────────────────────────────────────────────────────
  async listMessages(conversationId: string): Promise<CopilotMessage[]> {
    return db
      .select()
      .from(copilotMessages)
      .where(eq(copilotMessages.conversationId, conversationId))
      .orderBy(asc(copilotMessages.createdAt));
  },

  async addMessage(data: {
    conversationId: string;
    role: string;
    parts: unknown;
  }): Promise<CopilotMessage> {
    const [row] = await db
      .insert(copilotMessages)
      .values({
        conversationId: data.conversationId,
        role: data.role,
        parts: data.parts,
      })
      .returning();
    return row!;
  },

  /**
   * Marca a tool-call `propose_changes` como resolvida na mensagem que a contém.
   * Localiza a part pelo `toolCallId` (estável no cliente, independente do id da
   * mensagem persistida) e grava `state: "output-available"` + `output`. Sem
   * chamada ao modelo — só fecha o ciclo human-in-the-loop de forma idempotente.
   * Retorna `true` se alguma part foi atualizada.
   */
  async resolveToolPart(
    conversationId: string,
    toolCallId: string,
    output: { status: "applied" | "discarded"; appliedCount?: number },
  ): Promise<boolean> {
    const rows = await this.listMessages(conversationId);
    for (const row of rows) {
      const parts = row.parts;
      if (!Array.isArray(parts)) continue;

      let changed = false;
      const nextParts = parts.map((part) => {
        if (
          part &&
          typeof part === "object" &&
          typeof (part as { type?: unknown }).type === "string" &&
          (part as { type: string }).type.startsWith("tool-") &&
          (part as { toolCallId?: unknown }).toolCallId === toolCallId
        ) {
          changed = true;
          return { ...part, state: "output-available", output };
        }
        return part;
      });

      if (changed) {
        await db
          .update(copilotMessages)
          .set({ parts: nextParts })
          .where(eq(copilotMessages.id, row.id));
        return true;
      }
    }
    return false;
  },
};
