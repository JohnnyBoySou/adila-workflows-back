/**
 * Ferramentas do Noud.
 *
 * `propose_changes` é uma tool **sem `execute`** (padrão human-in-the-loop do
 * Vercel AI SDK): quando o modelo a chama, o passo encerra com a tool-call
 * exposta ao cliente em vez de rodar no servidor. O front renderiza a proposta
 * e, ao "Aplicar", aplica as operações no canvas. O servidor nunca muta o
 * workflow — a decisão é sempre do usuário.
 *
 * Operações suportadas (campo `op`):
 *  - add_node    { nodeType, title?, config?, near? }  — `near` = id do nó de referência
 *  - connect     { from, to, label? }                  — `label` "true"/"false" para ramos do `if`
 *  - update_node { id, config?, title? }
 *  - delete_node { id }
 */
import { jsonSchema, tool, type ToolSet } from "ai";

const proposeChangesSchema = jsonSchema<{
  summary?: string;
  operations: Array<{
    op: "add_node" | "connect" | "update_node" | "delete_node";
    nodeType?: string;
    id?: string;
    title?: string;
    config?: Record<string, unknown>;
    from?: string;
    to?: string;
    label?: string;
    near?: string;
  }>;
}>({
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Resumo curto da proposta em português do Brasil.",
    },
    operations: {
      type: "array",
      description: "Lista ordenada de operações a aplicar no workflow.",
      items: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["add_node", "connect", "update_node", "delete_node"],
            description: "Tipo da operação.",
          },
          nodeType: {
            type: "string",
            description: "Para add_node: o tipo do nó (deve existir no catálogo).",
          },
          id: {
            type: "string",
            description:
              "Para update_node/delete_node: o id do nó existente. Para add_node: um id temporário curto (ex.: \"n1\") que pode ser referenciado em connect.from/to e near dentro da mesma proposta.",
          },
          title: { type: "string", description: "Título do nó (add_node/update_node)." },
          config: {
            type: "object",
            additionalProperties: true,
            description: "Configuração do nó (add_node/update_node).",
          },
          from: { type: "string", description: "Para connect: id do nó de origem." },
          to: { type: "string", description: "Para connect: id do nó de destino." },
          label: {
            type: "string",
            description: 'Para connect: rótulo da aresta (ex.: "true"/"false" no if).',
          },
          near: {
            type: "string",
            description: "Para add_node: id de um nó existente para posicionar o novo perto dele.",
          },
        },
        required: ["op"],
        additionalProperties: false,
      },
    },
  },
  required: ["operations"],
  additionalProperties: false,
});

/** ToolSet do Noud. `propose_changes` não tem `execute` (client-side). */
export const copilotTools: ToolSet = {
  propose_changes: tool({
    description:
      "Propõe alterações no workflow (adicionar/conectar/atualizar/remover nós) para o usuário revisar e aplicar no canvas. Use sempre que o usuário pedir qualquer mudança no workflow.",
    inputSchema: proposeChangesSchema,
  }),
};
