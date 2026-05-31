/**
 * Montagem do system prompt do Noud.
 *
 * O prompt combina três blocos:
 *  1. Instruções de comportamento (sempre propor via `propose_changes`, nunca
 *     inventar node types fora do catálogo, ser conciso, falar pt-br).
 *  2. O catálogo compacto de node types (`renderCatalogForPrompt`).
 *  3. Um resumo do grafo atual (ids/tipos/títulos/edges), enviado a cada turno
 *     pelo front a partir do estado do canvas — é o que permite referenciar
 *     nós existentes para editar, conectar ou remover.
 */
import { renderCatalogForPrompt } from "./node-catalog";

export type GraphNodeSummary = {
  id: string;
  type: string;
  title?: string;
};

export type GraphEdgeSummary = {
  from: string;
  to: string;
  label?: string;
};

export type GraphSummary = {
  nodes: GraphNodeSummary[];
  edges: GraphEdgeSummary[];
};

function renderGraphSummary(graph: GraphSummary | undefined): string {
  if (!graph || graph.nodes.length === 0) {
    return "O workflow está vazio (nenhum nó ainda).";
  }
  const nodeLines = graph.nodes.map((n) => {
    const title = n.title ? ` "${n.title}"` : "";
    return `- ${n.id} [${n.type}]${title}`;
  });
  const edgeLines =
    graph.edges.length === 0
      ? ["(sem conexões)"]
      : graph.edges.map((e) => {
          const label = e.label ? ` (${e.label})` : "";
          return `- ${e.from} → ${e.to}${label}`;
        });
  return [`Nós (${graph.nodes.length}):`, ...nodeLines, "", "Conexões:", ...edgeLines].join("\n");
}

const BEHAVIOR = `Você é o Noud, um assistente de IA embutido no editor de workflows da Adila.
Sua função é ajudar o usuário a **criar e dar manutenção** em workflows: adicionar nós, conectá-los, ajustar configurações e remover o que não serve.

Princípios:
- Responda sempre em português do Brasil, de forma direta e concisa.
- Quando o usuário pedir qualquer alteração no workflow, **proponha** as mudanças chamando a ferramenta \`propose_changes\` com a lista de operações. NUNCA descreva as mudanças só em texto quando puder propô-las pela ferramenta.
- Não aplique nada sozinho: a proposta é revisada e aplicada pelo usuário. Após propor, explique em uma frase curta o que a proposta faz.
- Use **apenas** os \`nodeType\`s do catálogo abaixo. Nunca invente tipos que não existam nele.
- Para editar, conectar ou remover, use os \`id\`s reais dos nós que aparecem no resumo do grafo atual.
- Ao adicionar nós novos que se conectam entre si, atribua a cada \`add_node\` um \`id\` temporário curto (ex.: "n1", "n2") e use esse mesmo \`id\` nos campos \`from\`/\`to\` de \`connect\` e em \`near\`. Para nós que já existem, use o id real do grafo.
- Ao adicionar um nó que deve vir depois de outro, posicione-o com \`near\` apontando para o nó de referência (id real ou temporário) e crie a conexão correspondente.
- O nó \`if\` tem duas saídas (true/false); ao conectar a partir dele, use \`label\` "true" ou "false" para indicar o ramo.
- Se o pedido for ambíguo, faça no máximo uma pergunta objetiva antes de propor. Caso contrário, proponha direto.`;

export function buildSystemPrompt(graph: GraphSummary | undefined): string {
  return [
    BEHAVIOR,
    "",
    "## Catálogo de nós disponíveis",
    renderCatalogForPrompt(),
    "",
    "## Estado atual do workflow",
    renderGraphSummary(graph),
  ].join("\n");
}
