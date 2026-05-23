/**
 * Tradutores de `parameters` do n8n → `config` dos nossos nós.
 *
 * Cada função recebe o objeto cru de `parameters` do n8n e devolve um
 * `config` no formato que o handler correspondente espera. Quando algo
 * não tem tradução clara, o objeto original fica em `config._n8n` pra
 * o editor exibir e o usuário ajustar manualmente.
 *
 * Expressões: o n8n usa `={{ $json.X }}` e `={{ $('NodeName').item.json.X }}`;
 * a função `rewriteExpr` traduz esses padrões pro nosso template engine
 * (`{{ input.X }}`, `{{ steps.<id>.X }}`).
 */

type Params = Record<string, unknown>;

// ── expression rewriter ────────────────────────────────────────────────
function rewriteExpr(value: string, nameToId: Map<string, string>): string {
  // n8n marca strings que são expressões com `=` na frente.
  let v = value.startsWith("=") ? value.slice(1) : value;

  // $('NodeName').item.json.X.Y → steps.<id>.X.Y  (se o nome for resolvível)
  v = v.replaceAll(
    /\$\(['"]([^'"]+)['"]\)(?:\.item)?\.json\.([\w.]+)/g,
    (match, name: string, path: string) => {
      const id = nameToId.get(name);
      return id ? `steps.${id}.${path}` : match;
    },
  );

  // $json.X.Y → input.X.Y  (heurística — n8n trata como "item atual";
  // aproximação para a entrada do workflow)
  v = v.replaceAll(/\$json\.([\w.]+)/g, "input.$1");

  return v;
}

function rewriteDeep(value: unknown, nameToId: Map<string, string>): unknown {
  if (typeof value === "string") return rewriteExpr(value, nameToId);
  if (Array.isArray(value)) return value.map((v) => rewriteDeep(v, nameToId));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Params)) {
      out[k] = rewriteDeep(v, nameToId);
    }
    return out;
  }
  return value;
}

// ── operator mapping (if/filter) ───────────────────────────────────────
const OPERATOR_MAP: Record<string, string> = {
  equals: "eq",
  notEquals: "neq",
  isEmpty: "falsy",
  notEmpty: "truthy",
  contains: "contains",
  gt: "gt",
  greater: "gt",
  gte: "gte",
  greaterEqual: "gte",
  lt: "lt",
  less: "lt",
  lte: "lte",
  lessEqual: "lte",
};

// ── redis op mapping ───────────────────────────────────────────────────
const REDIS_OP_MAP: Record<string, string> = {
  get: "get",
  set: "set",
  delete: "del",
  del: "del",
  incr: "incr",
  decr: "decr",
  expire: "expire",
  ttl: "ttl",
  exists: "exists",
  push: "rpush", // "push" do n8n é tail-append → RPUSH
  rpush: "rpush",
  lpush: "lpush",
  pop: "lpop",
  hget: "hget",
  hset: "hset",
  hdel: "hdel",
};

// ── translators ────────────────────────────────────────────────────────
type Ctx = { params: Params; nameToId: Map<string, string> };

function translateStart({ params }: Ctx): Params {
  // start ecoa o input — não precisa de config. Preserva pra editor.
  return { _n8n: params };
}

function translateNoop(): Params {
  return {};
}

function translateSet({ params, nameToId }: Ctx): Params {
  const list = (params.assignments as Params | undefined)?.assignments;
  if (!Array.isArray(list)) return { _n8n: params };
  const variables: Record<string, unknown> = {};
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Params;
    if (typeof a.name === "string") {
      variables[a.name] = rewriteDeep(a.value, nameToId);
    }
  }
  return { variables };
}

function translateIf({ params, nameToId }: Ctx): Params {
  const conds = (params.conditions as Params | undefined)?.conditions;
  if (!Array.isArray(conds) || conds.length === 0) return { _n8n: params };
  const first = conds[0] as Params;
  const operator = (first.operator as Params | undefined)?.operation;
  const op = OPERATOR_MAP[String(operator)] ?? "eq";
  return {
    left: rewriteDeep(first.leftValue, nameToId),
    op,
    right: rewriteDeep(first.rightValue, nameToId),
  };
}

function translateWait({ params }: Ctx): Params {
  if (params.resume === "specificTime" && typeof params.dateTime === "string") {
    return { until: params.dateTime };
  }
  const amountRaw = params.amount;
  const amount =
    typeof amountRaw === "number" ? amountRaw : Number.parseFloat(String(amountRaw ?? "1"));
  if (!Number.isFinite(amount)) return { seconds: 1 };
  const unit = typeof params.unit === "string" ? params.unit : "seconds";
  const multiplier = unit === "hours" ? 3600 : unit === "minutes" ? 60 : 1;
  return { seconds: amount * multiplier };
}

function translateHttpRequest({ params, nameToId }: Ctx): Params {
  const url = rewriteDeep(params.url, nameToId);
  const method = typeof params.method === "string" ? params.method : "GET";

  const headers: Record<string, string> = {};
  const headerList = (params.headerParameters as Params | undefined)?.parameters;
  if (Array.isArray(headerList)) {
    for (const raw of headerList) {
      if (!raw || typeof raw !== "object") continue;
      const h = raw as Params;
      if (typeof h.name === "string" && h.value !== undefined) {
        headers[h.name] = String(rewriteDeep(h.value, nameToId));
      }
    }
  }

  let body: unknown;
  if (params.sendBody) {
    if (params.jsonBody !== undefined) {
      body = rewriteDeep(params.jsonBody, nameToId);
    } else {
      const bodyList = (params.bodyParameters as Params | undefined)?.parameters;
      if (Array.isArray(bodyList)) {
        const obj: Record<string, unknown> = {};
        for (const raw of bodyList) {
          if (!raw || typeof raw !== "object") continue;
          const p = raw as Params;
          if (typeof p.name === "string") obj[p.name] = rewriteDeep(p.value, nameToId);
        }
        body = obj;
      }
    }
  }

  const timeout = (params.options as Params | undefined)?.timeout;

  return {
    url,
    method,
    ...(Object.keys(headers).length > 0 && { headers }),
    ...(body !== undefined && { body }),
    ...(typeof timeout === "number" && { timeoutMs: timeout }),
  };
}

function translateRedis({ params, nameToId }: Ctx): Params {
  const rawOp = typeof params.operation === "string" ? params.operation : "get";
  const operation = REDIS_OP_MAP[rawOp] ?? rawOp;

  // n8n usa nomes específicos por operação (`key`, `list`, `value`, `messageData`, etc).
  // Ordem aproximada dos args pro nosso handler — usuário pode ajustar.
  const args: unknown[] = [];
  const target = params.list ?? params.key;
  if (target !== undefined) args.push(rewriteDeep(target, nameToId));
  const value = params.messageData ?? params.value;
  if (value !== undefined) args.push(rewriteDeep(value, nameToId));

  return {
    connectionString: "{{ env.REDIS_URL }}",
    operation,
    args,
  };
}

function translatePostgres({ params, nameToId }: Ctx): Params {
  const query = rewriteDeep(params.query, nameToId);
  return {
    connectionString: "{{ env.POSTGRES_URL }}",
    query: typeof query === "string" ? query : "",
    params: [],
  };
}

function translateSwitch({ params, nameToId }: Ctx): Params {
  const values = (params.rules as Params | undefined)?.values;
  if (!Array.isArray(values) || values.length === 0) {
    return { value: "", cases: [], _n8n: params };
  }

  // Heurística: usa o leftValue da primeira regra como `value` do switch
  // e cada rightValue vira um case rotulado pelo índice (casa com os edges).
  const firstRule = values[0] as Params;
  const firstCond = (
    (firstRule.conditions as Params | undefined)?.conditions as Params[] | undefined
  )?.[0];
  const value = rewriteDeep(firstCond?.leftValue, nameToId);

  const cases = values.map((raw, i) => {
    const rule = raw as Params;
    const cond = ((rule.conditions as Params | undefined)?.conditions as Params[] | undefined)?.[0];
    return {
      match: rewriteDeep(cond?.rightValue, nameToId),
      label: String(i),
    };
  });

  return { value, cases, default: "default" };
}

function translateCode({ params }: Ctx): Params {
  // O n8n usa `$input.item.json.X` e `$('Node').item.json.X` *dentro* do código;
  // não dá pra reescrever expressões em JS arbitrário. Mantemos o código cru —
  // o usuário precisa adaptar pra ler de `input`, `vars`, `steps`, `env`.
  const code = typeof params.jsCode === "string" ? params.jsCode : "";
  return { code };
}

function translateSplitInBatches({ params, nameToId }: Ctx): Params {
  const batchSizeRaw = params.batchSize;
  const batchSize =
    typeof batchSizeRaw === "number"
      ? batchSizeRaw
      : Number.parseInt(String(batchSizeRaw ?? "1"), 10);
  return {
    items: rewriteDeep(params.items ?? [], nameToId),
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 1,
  };
}

function translateEmbeddings({ params }: Ctx): Params {
  const modelValue = (params.model as Params | undefined)?.value;
  return {
    // text/texts não vem do n8n (a SDK do n8n liga via conexão ai_embedding).
    // O usuário precisa ligar manualmente no editor.
    model: typeof modelValue === "string" ? modelValue : "text-embedding-3-small",
  };
}

function translateVectorStore({ params }: Ctx): Params {
  // mode do n8n: "insert" | "load" | "retrieve" | "retrieve-as-tool".
  // No nosso engine só temos "insert" e "search".
  const rawMode = String(params.mode ?? "search");
  const operation = rawMode === "insert" ? "insert" : "search";
  const tableName = typeof params.tableName === "string" ? params.tableName : "documents";
  const topK = (params.options as Params | undefined)?.topK;
  return {
    connectionString: "{{ env.POSTGRES_URL }}",
    table: tableName,
    operation,
    ...(operation === "search" && typeof topK === "number" && { topK }),
    // `embedding` e `content`/`metadata` são ligados via outras conexões no n8n —
    // o usuário precisa preencher manualmente no editor (referenciando o nó de embeddings).
    _n8n: { ...params, _note: "ligue embedding/content/metadata manualmente" },
  };
}

function translateChatMemory({ params, nameToId }: Ctx): Params {
  const sessionKey = rewriteDeep(params.sessionKey, nameToId);
  const tableName = typeof params.tableName === "string" ? params.tableName : "chat_messages";
  return {
    connectionString: "{{ env.POSTGRES_URL }}",
    table: tableName,
    sessionId: typeof sessionKey === "string" ? sessionKey : String(sessionKey ?? ""),
    // n8n combina load+append no mesmo nó implicitamente; aqui o usuário escolhe.
    operation: "load",
    ...(typeof params.contextWindowLength === "number" && { limit: params.contextWindowLength }),
  };
}

function translateDocumentLoader({ params, nameToId }: Ctx): Params {
  const text = rewriteDeep(params.jsonData ?? params.textData ?? "", nameToId);
  const opts = (params.options as Params | undefined) ?? {};
  const meta = (opts.metadata as Params | undefined)?.metadataValues;
  const metadata: Record<string, unknown> = {};
  if (Array.isArray(meta)) {
    for (const raw of meta) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Params;
      if (typeof m.name === "string") metadata[m.name] = rewriteDeep(m.value, nameToId);
    }
  }
  return {
    text: typeof text === "string" ? text : String(text ?? ""),
    ...(typeof opts.chunkSize === "number" && { chunkSize: opts.chunkSize }),
    ...(typeof opts.chunkOverlap === "number" && { chunkOverlap: opts.chunkOverlap }),
    ...(Object.keys(metadata).length > 0 && { metadata }),
  };
}

function translateAiChat({ params, nameToId }: Ctx): Params {
  // n8n agent/lmChatOpenAi guardam texto em locais diferentes.
  let prompt: unknown = params.text ?? params.prompt ?? "";
  const messages = (params.messages as Params | undefined)?.messageValues;
  if (!prompt && Array.isArray(messages) && messages.length > 0) {
    prompt = (messages[0] as Params)?.content ?? "";
  }
  const modelValue = (params.model as Params | undefined)?.value;
  return {
    provider: "anthropic",
    model: typeof modelValue === "string" ? modelValue : "claude-sonnet-4-6",
    prompt: rewriteDeep(prompt, nameToId),
    ...(typeof (params.options as Params | undefined)?.systemMessage === "string" && {
      system: rewriteDeep((params.options as Params).systemMessage, nameToId),
    }),
  };
}

// ── dispatch ───────────────────────────────────────────────────────────
/**
 * Tipos que o importer sabe mapear. Fonte única — `n8n-import.ts` reusa esse tipo
 * em vez de duplicar a união, então adicionar entrada no TYPE_MAP de lá força
 * registro do tradutor aqui (typecheck garante).
 */
export type MappedType =
  | "start"
  | "set_variable"
  | "http_request"
  | "if"
  | "ai_chat"
  | "noop"
  | "wait"
  | "switch"
  | "postgres"
  | "redis"
  | "code"
  | "split_in_batches"
  | "embeddings"
  | "vector_store"
  | "chat_memory"
  | "document_loader"
  | "sticky_note";

function translateStickyNote({ params }: Ctx): Params {
  // n8n stickyNote.parameters: { content (markdown), height, width, color (number 1-7) }
  const content = typeof params.content === "string" ? params.content : "";
  const width = typeof params.width === "number" ? params.width : undefined;
  const height = typeof params.height === "number" ? params.height : undefined;
  const color = typeof params.color === "number" ? params.color : undefined;
  return {
    content,
    ...(width !== undefined && { width }),
    ...(height !== undefined && { height }),
    ...(color !== undefined && { color }),
  };
}

const TRANSLATORS: Record<MappedType, (ctx: Ctx) => Params> = {
  start: translateStart,
  noop: translateNoop,
  set_variable: translateSet,
  if: translateIf,
  wait: translateWait,
  http_request: translateHttpRequest,
  redis: translateRedis,
  postgres: translatePostgres,
  switch: translateSwitch,
  ai_chat: translateAiChat,
  code: translateCode,
  split_in_batches: translateSplitInBatches,
  embeddings: translateEmbeddings,
  vector_store: translateVectorStore,
  chat_memory: translateChatMemory,
  document_loader: translateDocumentLoader,
  sticky_note: translateStickyNote,
};

/**
 * Roda o tradutor correspondente ao tipo. Sempre injeta `_n8n.parameters`
 * com o cru pro editor poder mostrar/auditar.
 */
export function translateN8nParameters(
  mappedType: MappedType,
  parameters: Params | undefined,
  nameToId: Map<string, string>,
): Params {
  const params = parameters ?? {};
  // Fallback defensivo: se um dia o TYPE_MAP ganhar entrada sem tradutor
  // (drift entre arquivos), em vez de explodir mantemos o cru e o editor mostra.
  const translator = TRANSLATORS[mappedType];
  const config = translator ? translator({ params, nameToId }) : { _n8n: params };
  // Mantém parâmetros originais pra debug/editor (sem sobrescrever campos traduzidos).
  if (!("_n8n" in config)) config._n8n = params;
  return config;
}
