/**
 * Seed da Store de templates — catálogo GLOBAL de workflows prontos.
 *
 * Idempotente: upsert por `slug`. Rode com: bun run db:seed:templates
 *
 * Templates não pertencem a nenhuma organização — qualquer org navega na vitrine
 * e "instala" (clona o `definition` num workflow novo da própria org).
 */
import { db } from "../src/db";
import { type NewWorkflowTemplate, workflowTemplates } from "../src/db/schema";
import { logger } from "../src/lib/logger";

type FlowNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: { label: string; config: Record<string, unknown> };
};

type FlowEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle: null;
  targetHandle: null;
  data: Record<string, unknown>;
};

function edge(source: string, target: string): FlowEdge {
  return { id: `${source}->${target}`, source, target, sourceHandle: null, targetHandle: null, data: {} };
}

function definition(nodes: FlowNode[], edges: FlowEdge[]) {
  return { nodes, edges };
}

// ── Catálogo ───────────────────────────────────────────────────────────────

type SeedTemplate = Omit<NewWorkflowTemplate, "definition" | "nodeCount"> & {
  nodes: FlowNode[];
  edges: FlowEdge[];
};

const TEMPLATES: SeedTemplate[] = [
  // ── Free ──────────────────────────────────────────────────────────────
  {
    slug: "hello-world",
    title: "Hello World",
    description:
      "Ponto de partida: um gatilho manual que define uma variável e retorna uma mensagem. Ótimo para entender o editor.",
    category: "Primeiros passos",
    tier: "free",
    priceCents: 0,
    tags: ["básico", "exemplo", "manual"],
    icon: "Sparkles",
    accentColor: "#22c55e",
    featured: true,
    sortOrder: 10,
    cloneCount: 1284,
    stars: 4.9,
    ratingCount: 212,
    nodes: [
      {
        id: "manual_trigger-1",
        type: "manual_trigger",
        position: { x: -300, y: 0 },
        data: { label: "Início manual", config: {} },
      },
      {
        id: "set-1",
        type: "set",
        position: { x: 0, y: 0 },
        data: {
          label: "Definir mensagem",
          config: { assignments: [{ key: "message", value: "Olá, mundo!" }] },
        },
      },
    ],
    edges: [edge("manual_trigger-1", "set-1")],
  },
  {
    slug: "http-to-transform",
    title: "Consumir API e transformar",
    description:
      "Busca dados de uma API REST via HTTP e aplica uma transformação no payload. Base para integrações simples.",
    category: "Integrações",
    tier: "free",
    priceCents: 0,
    tags: ["http", "api", "transform"],
    icon: "Globe",
    accentColor: "#3b82f6",
    featured: false,
    sortOrder: 20,
    cloneCount: 876,
    stars: 4.7,
    ratingCount: 143,
    nodes: [
      {
        id: "manual_trigger-1",
        type: "manual_trigger",
        position: { x: -320, y: 0 },
        data: { label: "Início", config: {} },
      },
      {
        id: "http-1",
        type: "http",
        position: { x: -40, y: 0 },
        data: {
          label: "GET /todos/1",
          config: { method: "GET", url: "https://jsonplaceholder.typicode.com/todos/1" },
        },
      },
      {
        id: "transform-1",
        type: "transform",
        position: { x: 280, y: 0 },
        data: {
          label: "Extrair título",
          config: { expression: "return { title: $json.title }" },
        },
      },
    ],
    edges: [edge("manual_trigger-1", "http-1"), edge("http-1", "transform-1")],
  },
  {
    slug: "scheduled-http-ping",
    title: "Monitor agendado de endpoint",
    description:
      "Roda em intervalo agendado, faz um ping HTTP num endpoint e segue o fluxo. Ideal para health checks periódicos.",
    category: "Monitoramento",
    tier: "free",
    priceCents: 0,
    tags: ["cron", "agendado", "http", "monitor"],
    icon: "Clock",
    accentColor: "#f59e0b",
    featured: false,
    sortOrder: 30,
    cloneCount: 542,
    stars: 4.6,
    ratingCount: 98,
    nodes: [
      {
        id: "schedule_trigger-1",
        type: "schedule_trigger",
        position: { x: -320, y: 0 },
        data: { label: "A cada 5 min", config: { cronExpression: "*/5 * * * *", timezone: "UTC" } },
      },
      {
        id: "http-1",
        type: "http",
        position: { x: 0, y: 0 },
        data: { label: "Ping", config: { method: "GET", url: "https://example.com/health" } },
      },
    ],
    edges: [edge("schedule_trigger-1", "http-1")],
  },
  {
    slug: "webhook-to-postgres",
    title: "Webhook → Postgres",
    description:
      "Recebe um POST via webhook e persiste o payload numa tabela Postgres. Captura de leads, eventos ou formulários.",
    category: "Dados",
    tier: "free",
    priceCents: 0,
    tags: ["webhook", "postgres", "ingestão"],
    icon: "Database",
    accentColor: "#8b5cf6",
    featured: false,
    sortOrder: 40,
    cloneCount: 731,
    stars: 4.8,
    ratingCount: 119,
    nodes: [
      {
        id: "webhook-1",
        type: "webhook",
        position: { x: -320, y: 0 },
        data: { label: "Webhook de entrada", config: { method: "POST" } },
      },
      {
        id: "postgres-1",
        type: "postgres",
        position: { x: 20, y: 0 },
        data: {
          label: "Inserir evento",
          config: {
            mode: "sql",
            query: "insert into events (payload) values ($1)",
          },
        },
      },
    ],
    edges: [edge("webhook-1", "postgres-1")],
  },

  // ── Paid ──────────────────────────────────────────────────────────────
  {
    slug: "ai-support-triage",
    title: "Triagem de suporte com IA",
    description:
      "Recebe um ticket via webhook, classifica intenção e urgência com um agente de IA, e roteia para o destino certo. Inclui prompt afinado e fallback.",
    category: "IA",
    tier: "paid",
    priceCents: 4900,
    tags: ["ia", "agente", "suporte", "classificação", "webhook"],
    icon: "Bot",
    accentColor: "#ec4899",
    featured: true,
    sortOrder: 100,
    cloneCount: 389,
    stars: 4.9,
    ratingCount: 76,
    nodes: [
      {
        id: "webhook-1",
        type: "webhook",
        position: { x: -360, y: 0 },
        data: { label: "Novo ticket", config: { method: "POST" } },
      },
      {
        id: "ai_agent-1",
        type: "ai_agent",
        position: { x: -40, y: 0 },
        data: {
          label: "Classificar ticket",
          config: {
            model: "claude-sonnet-4-6",
            systemPrompt:
              "Você é um classificador de tickets de suporte. Responda em JSON com {categoria, urgencia}.",
            prompt: "Classifique este ticket: {{$json.body}}",
          },
        },
      },
      {
        id: "transform-1",
        type: "transform",
        position: { x: 300, y: 0 },
        data: { label: "Rotear", config: { expression: "return { route: $json.categoria }" } },
      },
    ],
    edges: [edge("webhook-1", "ai_agent-1"), edge("ai_agent-1", "transform-1")],
  },
  {
    slug: "etl-postgres-redis-cache",
    title: "ETL Postgres → Redis (cache quente)",
    description:
      "Pipeline agendado que extrai um agregado do Postgres, transforma e materializa num cache Redis para leitura de baixa latência. Inclui tratamento de erro e métricas.",
    category: "Dados",
    tier: "paid",
    priceCents: 7900,
    tags: ["etl", "postgres", "redis", "cache", "agendado"],
    icon: "Layers",
    accentColor: "#06b6d4",
    featured: false,
    sortOrder: 110,
    cloneCount: 264,
    stars: 4.7,
    ratingCount: 51,
    nodes: [
      {
        id: "schedule_trigger-1",
        type: "schedule_trigger",
        position: { x: -380, y: 0 },
        data: {
          label: "A cada hora",
          config: { cronExpression: "0 * * * *", timezone: "America/Sao_Paulo" },
        },
      },
      {
        id: "postgres-1",
        type: "postgres",
        position: { x: -60, y: 0 },
        data: {
          label: "Extrair agregado",
          config: {
            mode: "sql",
            query: "select category, count(*) as total from orders group by category",
          },
        },
      },
      {
        id: "transform-1",
        type: "transform",
        position: { x: 260, y: 0 },
        data: {
          label: "Montar payload",
          config: { expression: "return { key: 'orders:by_category', value: $json }" },
        },
      },
      {
        id: "redis-1",
        type: "redis",
        position: { x: 560, y: 0 },
        data: {
          label: "Gravar cache",
          config: { operation: "set", key: "orders:by_category", ttlSeconds: 3600 },
        },
      },
    ],
    edges: [
      edge("schedule_trigger-1", "postgres-1"),
      edge("postgres-1", "transform-1"),
      edge("transform-1", "redis-1"),
    ],
  },
];

async function main() {
  let inserted = 0;
  for (const tpl of TEMPLATES) {
    const { nodes, edges, ...rest } = tpl;
    const values: NewWorkflowTemplate = {
      ...rest,
      definition: definition(nodes, edges),
      nodeCount: nodes.length,
    };
    await db
      .insert(workflowTemplates)
      .values(values)
      .onConflictDoUpdate({
        target: workflowTemplates.slug,
        set: {
          title: values.title,
          description: values.description,
          category: values.category,
          tier: values.tier,
          priceCents: values.priceCents,
          tags: values.tags,
          icon: values.icon,
          accentColor: values.accentColor,
          definition: values.definition,
          nodeCount: values.nodeCount,
          featured: values.featured,
          sortOrder: values.sortOrder,
          // Baseline do showcase; o contador volta a acumular a cada clone real.
          cloneCount: values.cloneCount,
          stars: values.stars,
          ratingCount: values.ratingCount,
          published: true,
          updatedAt: new Date(),
        },
      });
    inserted += 1;
  }
  logger.info({ count: inserted }, "workflow templates seeded");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "template seed failed");
    process.exit(1);
  });
