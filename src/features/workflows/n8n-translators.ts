/**
 * Tradutores de `parameters` do n8n → `config` dos nossos nós.
 *
 * Cada função recebe o objeto cru de `parameters` do n8n e devolve um
 * `config` no formato que o handler correspondente espera. Quando algo
 * não tem tradução clara, o objeto original fica em `config._n8n` pra
 * o editor exibir e o usuário ajustar manualmente.
 *
 * Expressions: o n8n usa diversos padrões — `={{ $json.X }}`,
 * `={{ $('NodeName').item.json.X }}`, `={{ $now }}`, `={{ $execution.id }}`,
 * etc. A função `rewriteExpr` traduz pro nosso template engine
 * (`{{ input.X }}`, `{{ steps.<id>.X }}`, helpers diversos).
 */

type Params = Record<string, unknown>;

// ── expression rewriter ────────────────────────────────────────────────
/**
 * Reescreve expressões n8n para a sintaxe do template engine adila.
 *
 * Padrões cobertos:
 *  - `$('NodeName').item.json.X`     → `steps.<id>.X`
 *  - `$('NodeName').first().json.X`  → `steps.<id>.X`
 *  - `$('NodeName').last().json.X`   → `steps.<id>.X`
 *  - `$('NodeName').all()`           → `steps.<id>`
 *  - `$node["NodeName"].json.X`      → `steps.<id>.X`
 *  - `$node.NodeName.json.X`         → `steps.<id>.X`
 *  - `$json.X.Y`                     → `input.X.Y` (heurística — item atual)
 *  - `$input.all()`                  → `input` (best-effort)
 *  - `$input.first().json.X`         → `input.X`
 *  - `$input.item.json.X`            → `input.X`
 *  - `$vars.X`                       → `vars.X`
 *  - `$env.X`                        → `env.X`
 *  - `$now`                          → `{{$now}}` (placeholder pro template)
 *  - `$today`                        → `{{$today}}`
 *  - `$execution.id`                 → `{{$execution.id}}` (placeholder)
 *  - `$workflow.id`                  → `{{$workflow.id}}` (placeholder)
 *  - `$prevNode.X`                   → `prev.X`
 */
export function rewriteExpr(value: string, nameToId: Map<string, string>): string {
  // n8n marca strings que são expressões com `=` na frente.
  let v = value.startsWith("=") ? value.slice(1) : value;

  // $('NodeName').item.json.X | $('NodeName').first().json.X | $('NodeName').last().json.X
  v = v.replaceAll(
    /\$\(['"]([^'"]+)['"]\)(?:\.item|\.first\(\)|\.last\(\))?\.json\.([\w.[\]]+)/g,
    (match, name: string, path: string) => {
      const id = nameToId.get(name);
      return id ? `steps.${id}.${path}` : match;
    },
  );

  // $('NodeName').all() → steps.<id>
  v = v.replaceAll(/\$\(['"]([^'"]+)['"]\)\.all\(\)/g, (match, name: string) => {
    const id = nameToId.get(name);
    return id ? `steps.${id}` : match;
  });

  // $node["NodeName"].json.X  |  $node['NodeName'].json.X
  v = v.replaceAll(
    /\$node\[['"]([^'"]+)['"]\]\.json\.([\w.[\]]+)/g,
    (match, name: string, path: string) => {
      const id = nameToId.get(name);
      return id ? `steps.${id}.${path}` : match;
    },
  );

  // $node.NodeName.json.X  (sintaxe shorthand)
  v = v.replaceAll(/\$node\.([A-Za-z_][\w]*)\.json\.([\w.[\]]+)/g, (match, name: string, path: string) => {
    const id = nameToId.get(name);
    return id ? `steps.${id}.${path}` : match;
  });

  // $input.item.json.X | $input.first().json.X | $input.last().json.X → input.X
  v = v.replaceAll(/\$input(?:\.item|\.first\(\)|\.last\(\))?\.json\.([\w.[\]]+)/g, "input.$1");
  // $input.all() → input (best-effort)
  v = v.replaceAll(/\$input\.all\(\)/g, "input");
  // $items() → input (best-effort, sem arg)
  v = v.replaceAll(/\$items\(\)/g, "input");

  // $json.X.Y → prev.X.Y — `prev` espelha o item atual fluindo entre nós
  // (definido pelo executor após cada step). Resolve cenário comum:
  // `set_variable` (output={x: 1}) → `if` (`{{ $json.x }}`) acessa correto.
  v = v.replaceAll(/\$json\.([\w.[\]]+)/g, "prev.$1");
  // Variante com colchetes (chaves com caracteres especiais ou espaços),
  // ex.: $json['conversação IA'] → prev['conversação IA']
  v = v.replaceAll(/\$json\[(['"][^'"]+['"])\]/g, "prev[$1]");

  // $vars.X → vars.X
  v = v.replaceAll(/\$vars\.([\w.[\]]+)/g, "vars.$1");
  // $env.X → env.X
  v = v.replaceAll(/\$env\.([\w.[\]]+)/g, "env.$1");

  // $prevNode.X → prev.X (saída do nó anterior — best-effort, sem id resolvido)
  v = v.replaceAll(/\$prevNode\.([\w.[\]]+)/g, "prev.$1");

  // Variáveis globais (mantém como placeholders — quem renderiza decide).
  // Sem prefixo $ pra não conflitar com sintaxe nossa, mas marca:
  //   $now → {{$now}}, $today → {{$today}}
  //   $execution.X → {{$execution.X}}, $workflow.X → {{$workflow.X}}
  v = v.replaceAll(/\$now\b/g, "$now");
  v = v.replaceAll(/\$today\b/g, "$today");
  v = v.replaceAll(/\$execution\.([\w.[\]]+)/g, "$execution.$1");
  v = v.replaceAll(/\$workflow\.([\w.[\]]+)/g, "$workflow.$1");

  return v;
}

export function rewriteDeep(value: unknown, nameToId: Map<string, string>): unknown {
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
  notContains: "ncontains",
  startsWith: "startsWith",
  endsWith: "endsWith",
  regex: "regex",
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
  push: "rpush",
  rpush: "rpush",
  lpush: "lpush",
  pop: "lpop",
  hget: "hget",
  hset: "hset",
  hdel: "hdel",
  publish: "publish",
};

// ── translators ────────────────────────────────────────────────────────
type Ctx = { params: Params; nameToId: Map<string, string> };

function translateStart({ params }: Ctx): Params {
  return { _n8n: params };
}

function translateNoop(): Params {
  return {};
}

function translateSet({ params, nameToId }: Ctx): Params {
  // n8n.set / n8n.editFields (v3+) compartilham mesmo shape: assignments.assignments[]
  const list = (params.assignments as Params | undefined)?.assignments;
  if (!Array.isArray(list)) {
    // Fallback legado: parâmetros chave-valor diretos em params.values
    const values = (params.values as Params | undefined)?.string ?? (params.values as Params | undefined)?.number;
    if (Array.isArray(values)) {
      const variables: Record<string, unknown> = {};
      for (const raw of values) {
        if (!raw || typeof raw !== "object") continue;
        const a = raw as Params;
        if (typeof a.name === "string") {
          variables[a.name] = rewriteDeep(a.value, nameToId);
        }
      }
      return { variables };
    }
    return { _n8n: params };
  }
  // Preserva o `type` n8n (string|number|boolean|object|array) num mapa paralelo,
  // pra que o engine consiga coagir o valor final no `renderTemplate` em runtime
  // (`set_variable` foi atualizado pra ler `_types`). Sem isso, expressões viram
  // string e comparações `===` com `true`/`number` falham (caso ai_enabled etc).
  const variables: Record<string, unknown> = {};
  const types: Record<string, string> = {};
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Params;
    if (typeof a.name === "string") {
      variables[a.name] = rewriteDeep(a.value, nameToId);
      if (typeof a.type === "string") types[a.name] = a.type;
    }
  }
  return {
    variables,
    ...(Object.keys(types).length > 0 && { _types: types }),
  };
}

function translateIf({ params, nameToId }: Ctx): Params {
  const conditions = params.conditions as Params | undefined;
  // v2+: conditions.conditions[] com { leftValue, rightValue, operator: { operation, type } }
  const conds = conditions?.conditions;
  if (Array.isArray(conds) && conds.length > 0) {
    const first = conds[0] as Params;
    const operator = (first.operator as Params | undefined)?.operation;
    const dataType = (first.operator as Params | undefined)?.type;
    const op = OPERATOR_MAP[String(operator)] ?? "eq";
    const out: Params = {
      left: rewriteDeep(first.leftValue, nameToId),
      op,
      right: rewriteDeep(first.rightValue, nameToId),
    };
    if (typeof dataType === "string") out.dataType = dataType;
    return out;
  }
  // v1: conditions.string|number|boolean|dateTime[] com { value1, value2, operation? }
  const v1Types: Array<[string, string]> = [
    ["string", "string"],
    ["number", "number"],
    ["boolean", "boolean"],
    ["dateTime", "dateTime"],
  ];
  for (const [key, dt] of v1Types) {
    const arr = conditions?.[key];
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0] as Params;
      const operation = typeof first.operation === "string" ? first.operation : "equals";
      const op = OPERATOR_MAP[operation] ?? "eq";
      return {
        left: rewriteDeep(first.value1, nameToId),
        op,
        right: rewriteDeep(first.value2, nameToId),
        dataType: dt,
      };
    }
  }
  return { _n8n: params };
}

function translateFilter(ctx: Ctx): Params {
  // n8n.filter é if que descarta items que não casam — para o adila vira `if` simples.
  return translateIf(ctx);
}

function translateWait({ params }: Ctx): Params {
  if (params.resume === "specificTime" && typeof params.dateTime === "string") {
    return { until: params.dateTime };
  }
  if (params.resume === "webhook") {
    return { waitForWebhook: true, _n8n: params };
  }
  const amountRaw = params.amount;
  const amount =
    typeof amountRaw === "number" ? amountRaw : Number.parseFloat(String(amountRaw ?? "1"));
  if (!Number.isFinite(amount)) return { seconds: 1 };
  const unit = typeof params.unit === "string" ? params.unit : "seconds";
  const multiplier =
    unit === "hours" ? 3600 : unit === "minutes" ? 60 : unit === "days" ? 86400 : 1;
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

  const queryParams: Record<string, unknown> = {};
  const qsList = (params.queryParameters as Params | undefined)?.parameters;
  if (Array.isArray(qsList)) {
    for (const raw of qsList) {
      if (!raw || typeof raw !== "object") continue;
      const q = raw as Params;
      if (typeof q.name === "string") queryParams[q.name] = rewriteDeep(q.value, nameToId);
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
  const auth = params.authentication;

  return {
    url,
    method,
    ...(Object.keys(headers).length > 0 && { headers }),
    ...(Object.keys(queryParams).length > 0 && { query: queryParams }),
    ...(body !== undefined && { body }),
    ...(typeof timeout === "number" && { timeoutMs: timeout }),
    ...(typeof auth === "string" && auth !== "none" && { auth }),
  };
}

function translateRedis({ params, nameToId }: Ctx): Params {
  const rawOp = typeof params.operation === "string" ? params.operation : "get";
  const operation = REDIS_OP_MAP[rawOp] ?? rawOp;

  const args: unknown[] = [];
  const target = params.list ?? params.key ?? params.channel;
  if (target !== undefined) args.push(rewriteDeep(target, nameToId));
  const value = params.messageData ?? params.value;
  if (value !== undefined) args.push(rewriteDeep(value, nameToId));

  // Engine espera `connectionRef` (nome lógico de uma `database_connection`
  // registrada) e resolve via worker. O importer não tem como saber qual
  // connection o usuário criou, então usa "default_redis" como convenção —
  // o usuário precisa cadastrar uma connection com esse nome (ou trocar
  // depois) antes de executar o workflow.
  return {
    connectionRef: "default_redis",
    operation,
    args,
  };
}

function translatePostgres({ params, nameToId }: Ctx): Params {
  const query = rewriteDeep(params.query, nameToId);
  const operation = typeof params.operation === "string" ? params.operation : "executeQuery";
  // Engine espera `connectionRef` (nome lógico de uma `database_connection`
  // registrada) e resolve via worker. Convenção: "default_postgres" —
  // usuário precisa cadastrar antes de rodar.
  return {
    connectionRef: "default_postgres",
    mode: "sql",
    query: typeof query === "string" ? query : "",
    params: [],
    ...(operation !== "executeQuery" && { _n8n_operation: operation }),
  };
}

function translateSwitch({ params, nameToId }: Ctx): Params {
  const values = (params.rules as Params | undefined)?.values;
  if (!Array.isArray(values) || values.length === 0) {
    return { value: "", cases: [], _n8n: params };
  }

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
  const code =
    typeof params.jsCode === "string"
      ? params.jsCode
      : typeof params.pythonCode === "string"
        ? params.pythonCode
        : typeof params.functionCode === "string"
          ? params.functionCode
          : "";
  const language =
    typeof params.language === "string"
      ? params.language
      : typeof params.pythonCode === "string"
        ? "python"
        : "javascript";
  return { code, language };
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
  const modelValue =
    (params.model as Params | undefined)?.value ??
    (typeof params.model === "string" ? params.model : undefined);
  return {
    model: typeof modelValue === "string" ? modelValue : "text-embedding-3-small",
    _n8n: params,
  };
}

function translateVectorStore({ params }: Ctx): Params {
  const rawMode = String(params.mode ?? "search");
  const operation = rawMode === "insert" ? "insert" : "search";
  const tableName =
    typeof params.tableName === "string"
      ? params.tableName
      : typeof params.collectionName === "string"
        ? params.collectionName
        : typeof params.indexName === "string"
          ? params.indexName
          : "documents";
  const topK = (params.options as Params | undefined)?.topK;
  return {
    connectionRef: "default_postgres",
    table: tableName,
    operation,
    ...(operation === "search" && typeof topK === "number" && { topK }),
    _n8n: { ...params, _note: "ligue embedding/content/metadata manualmente" },
  };
}

function translateChatMemory({ params, nameToId }: Ctx): Params {
  const sessionKey = rewriteDeep(params.sessionKey ?? params.sessionId, nameToId);
  const tableName = typeof params.tableName === "string" ? params.tableName : "chat_messages";
  return {
    connectionRef: "default_postgres",
    table: tableName,
    sessionId: typeof sessionKey === "string" ? sessionKey : String(sessionKey ?? ""),
    operation: "load",
    ...(typeof params.contextWindowLength === "number" && { limit: params.contextWindowLength }),
    _n8n: params,
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
  // n8n agent / lmChat* / openAi / chainLlm guardam texto em locais diferentes.
  let prompt: unknown = params.text ?? params.prompt ?? params.input ?? "";
  const messages = (params.messages as Params | undefined)?.messageValues;
  if (!prompt && Array.isArray(messages) && messages.length > 0) {
    prompt = (messages[0] as Params)?.content ?? "";
  }
  const modelValue =
    (params.model as Params | undefined)?.value ??
    (typeof params.model === "string" ? params.model : undefined);

  // Heurística de provider — usa nome do modelo pra inferir.
  const modelStr = String(modelValue ?? "");
  const provider =
    modelStr.includes("claude") || modelStr.startsWith("sonnet") || modelStr.startsWith("opus")
      ? "anthropic"
      : modelStr.includes("gemini")
        ? "google"
        : modelStr.includes("gpt") || modelStr.includes("o1") || modelStr.includes("o3")
          ? "openai"
          : modelStr.includes("mistral")
            ? "mistral"
            : modelStr.includes("llama") || modelStr.includes("ollama")
              ? "ollama"
              : "openai";

  return {
    provider,
    model: modelStr || "claude-sonnet-4-6",
    prompt: rewriteDeep(prompt, nameToId),
    ...(typeof (params.options as Params | undefined)?.systemMessage === "string" && {
      system: rewriteDeep((params.options as Params).systemMessage, nameToId),
    }),
  };
}

function translateDateTime({ params, nameToId }: Ctx): Params {
  const action = String(params.action ?? params.operation ?? "now");
  const opMap: Record<string, string> = {
    now: "now",
    parse: "parse",
    format: "format",
    formatDate: "format",
    add: "add",
    subtract: "add",
    calculate: "add",
    diff: "diff",
    getTimeBetweenDates: "diff",
  };
  const operation = opMap[action] ?? action;

  const value = rewriteDeep(params.value ?? params.date ?? "", nameToId);
  const cfg: Params = { operation };
  if (operation === "format") {
    cfg.value = value;
    cfg.format = typeof params.format === "string" ? params.format : "YYYY-MM-DD HH:mm:ss";
  } else if (operation === "add") {
    cfg.value = value;
    const amountRaw = Number(params.amount ?? 0);
    cfg.amount = action === "subtract" ? -amountRaw : amountRaw;
    cfg.unit = typeof params.unit === "string" ? params.unit : "seconds";
  } else if (operation === "diff") {
    cfg.from = rewriteDeep(params.from ?? params.startDate, nameToId);
    cfg.to = rewriteDeep(params.to ?? params.endDate, nameToId);
  } else if (operation === "parse") {
    cfg.value = value;
  }
  return cfg;
}

function translateCrypto({ params, nameToId }: Ctx): Params {
  const action = String(params.action ?? "hash");
  if (action === "generate") {
    const type = String(params.type ?? "uuid");
    return type === "uuid" ? { operation: "uuid" } : { operation: "random" };
  }
  const value = rewriteDeep(params.value ?? "", nameToId);
  const algo = String(params.type ?? params.algorithm ?? "sha256").toLowerCase();
  const encoding = String(params.encoding ?? "hex").toLowerCase();
  if (action === "hmac") {
    return {
      operation: "hmac",
      algorithm: algo,
      value,
      secret: rewriteDeep(params.secret ?? "", nameToId),
      encoding,
    };
  }
  return { operation: "hash", algorithm: algo, value, encoding };
}

function translateItemLists({ params, nameToId }: Ctx): Params {
  const op = String(params.operation ?? "filter");
  const items = rewriteDeep(params.items ?? params.fieldToSplitOut ?? [], nameToId);
  if (op === "limit") {
    return { operation: "slice", items, end: Number(params.maxItems ?? 10) };
  }
  if (op === "sort" || op === "sortItems") {
    return {
      operation: "sort",
      items,
      field: typeof params.fieldName === "string" ? params.fieldName : undefined,
      order: params.order === "descending" ? "desc" : "asc",
    };
  }
  if (op === "removeDuplicates") {
    return {
      operation: "distinct",
      items,
      field: typeof params.fieldName === "string" ? params.fieldName : undefined,
    };
  }
  return { operation: op, items, _n8n: params };
}

function translateAggregate({ params, nameToId }: Ctx): Params {
  const items = rewriteDeep(params.items ?? [], nameToId);
  const fields = (params.fieldsToAggregate as Params | undefined)?.fieldToAggregate;
  if (Array.isArray(fields) && fields.length > 0) {
    const f = fields[0] as Params;
    return {
      operation: "sum",
      items,
      field: typeof f.fieldToAggregate === "string" ? f.fieldToAggregate : "",
    };
  }
  return { operation: "count", items };
}

function translateExecuteWorkflow({ params, nameToId }: Ctx): Params {
  let workflowId = "";
  if (typeof params.workflowId === "string") workflowId = params.workflowId;
  else if (params.workflowId && typeof params.workflowId === "object") {
    const wf = params.workflowId as Params;
    if (typeof wf.value === "string") workflowId = wf.value;
  }
  return {
    workflowId,
    input: rewriteDeep(params.workflowInputs ?? {}, nameToId),
    _n8n_note: "Cole o uuid do sub-workflow no campo `workflowId`.",
  };
}

function translateStickyNote({ params }: Ctx): Params {
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

// ── tradutores adicionados na onda de paridade ─────────────────────────

function translateMerge({ params }: Ctx): Params {
  // n8n.merge: mode = "append" | "combine" | "chooseBranch" | "passThrough"
  const mode = String(params.mode ?? "append");
  return { mode, _n8n: params };
}

function translateSplitOut({ params, nameToId }: Ctx): Params {
  // n8n.splitOut: fieldToSplitOut (path) — itera array em N items.
  return {
    field: typeof params.fieldToSplitOut === "string" ? params.fieldToSplitOut : "",
    items: rewriteDeep(params.fieldToSplitOut ?? [], nameToId),
    _n8n: params,
  };
}

function translateRenameKeys({ params, nameToId }: Ctx): Params {
  // n8n.renameKeys: keys.key[] = { currentKey, newKey }
  const keys = (params.keys as Params | undefined)?.key;
  const mapping: Record<string, string> = {};
  if (Array.isArray(keys)) {
    for (const raw of keys) {
      if (!raw || typeof raw !== "object") continue;
      const k = raw as Params;
      if (typeof k.currentKey === "string" && typeof k.newKey === "string") {
        mapping[k.currentKey] = k.newKey;
      }
    }
  }
  return { mapping, items: rewriteDeep(params.items ?? [], nameToId) };
}

function translateSort({ params, nameToId }: Ctx): Params {
  const sortFields = (params.sortFieldsUi as Params | undefined)?.sortField ?? params.sortFields;
  let field: string | undefined;
  let order: "asc" | "desc" = "asc";
  if (Array.isArray(sortFields) && sortFields.length > 0) {
    const first = sortFields[0] as Params;
    if (typeof first.fieldName === "string") field = first.fieldName;
    if (first.order === "descending") order = "desc";
  }
  return {
    items: rewriteDeep(params.items ?? [], nameToId),
    field,
    order,
  };
}

function translateLimit({ params, nameToId }: Ctx): Params {
  const maxItems = Number(params.maxItems ?? 10);
  return {
    items: rewriteDeep(params.items ?? [], nameToId),
    limit: Number.isFinite(maxItems) ? maxItems : 10,
    keepBehavior: typeof params.keep === "string" ? params.keep : "firstItems",
  };
}

function translateRemoveDuplicates({ params, nameToId }: Ctx): Params {
  const compare = String(params.compare ?? "allFields");
  const fields = (params.fieldsToCompare as Params | undefined)?.fields;
  const fieldList: string[] = [];
  if (Array.isArray(fields)) {
    for (const raw of fields) {
      if (raw && typeof (raw as Params).fieldName === "string") {
        fieldList.push((raw as Params).fieldName as string);
      }
    }
  }
  return {
    items: rewriteDeep(params.items ?? [], nameToId),
    compare,
    fields: fieldList,
  };
}

function translateCompareDatasets({ params, nameToId }: Ctx): Params {
  return {
    inputA: rewriteDeep(params.inputA ?? [], nameToId),
    inputB: rewriteDeep(params.inputB ?? [], nameToId),
    mergeMode: typeof params.resolve === "string" ? params.resolve : "preferInput1",
    _n8n: params,
  };
}

function translateScheduleTrigger({ params }: Ctx): Params {
  // n8n.scheduleTrigger: rule.interval[] = { field, expression, hoursInterval, minutesInterval }
  // Mais comum: cronExpression em rule.interval[0].expression
  const rule = params.rule as Params | undefined;
  const intervals = rule?.interval;
  if (Array.isArray(intervals) && intervals.length > 0) {
    const first = intervals[0] as Params;
    if (typeof first.expression === "string") {
      return { cronExpression: first.expression, timezone: "UTC", _n8n: params };
    }
    if (first.field === "hours" && typeof first.hoursInterval === "number") {
      return { cronExpression: `0 */${first.hoursInterval} * * *`, timezone: "UTC", _n8n: params };
    }
    if (first.field === "minutes" && typeof first.minutesInterval === "number") {
      return { cronExpression: `*/${first.minutesInterval} * * * *`, timezone: "UTC", _n8n: params };
    }
  }
  return { cronExpression: "0 * * * *", timezone: "UTC", _n8n: params };
}

function translateIntervalTrigger({ params }: Ctx): Params {
  const unit = String(params.unit ?? "seconds");
  const interval = Number(params.interval ?? 60);
  const multiplier = unit === "hours" ? 3600 : unit === "minutes" ? 60 : 1;
  return { intervalSeconds: interval * multiplier, _n8n: params };
}

function translateManualTrigger({ params }: Ctx): Params {
  return { _n8n: params };
}

function translateErrorTrigger({ params }: Ctx): Params {
  return { _n8n: params };
}

function translateRssTrigger({ params, nameToId }: Ctx): Params {
  const feedUrl = rewriteDeep(params.feedUrl ?? params.url ?? "", nameToId);
  const pollTimes = params.pollTimes;
  return {
    feedUrl: typeof feedUrl === "string" ? feedUrl : "",
    pollIntervalSeconds: 3600,
    _n8n: { pollTimes, ...params },
  };
}

function translateEmailTrigger({ params, nameToId }: Ctx): Params {
  return {
    host: rewriteDeep(params.host ?? "", nameToId),
    port: typeof params.port === "number" ? params.port : 993,
    secure: params.secure !== false,
    mailbox: typeof params.mailbox === "string" ? params.mailbox : "INBOX",
    _n8n: params,
  };
}

function translateFormTrigger({ params }: Ctx): Params {
  // n8n.formTrigger / n8nFormTrigger: formTitle, formDescription, formFields.values[]
  return {
    formTitle: typeof params.formTitle === "string" ? params.formTitle : "",
    formDescription: typeof params.formDescription === "string" ? params.formDescription : "",
    fields: ((params.formFields as Params | undefined)?.values ?? []) as unknown,
    _n8n: params,
  };
}

function translateRespondToWebhook({ params, nameToId }: Ctx): Params {
  // n8n.respondToWebhook: respondWith, responseBody, responseCode, responseHeaders.
  // Engine adila lê { status, headers (Record), body } — então convertemos
  // o array de entries `[{name, value}]` em Record e renomeamos responseCode→status.
  const options = (params.options as Params | undefined) ?? {};
  const headersRaw =
    ((params.responseHeaders ?? options.responseHeaders) as Params | undefined)?.entries ?? [];
  const headers: Record<string, string> = {};
  if (Array.isArray(headersRaw)) {
    for (const h of headersRaw) {
      if (h && typeof h === "object") {
        const e = h as Params;
        if (typeof e.name === "string") {
          headers[e.name] = String(rewriteDeep(e.value, nameToId) ?? "");
        }
      }
    }
  } else if (headersRaw && typeof headersRaw === "object") {
    for (const [k, v] of Object.entries(headersRaw as Record<string, unknown>)) {
      headers[k] = String(rewriteDeep(v, nameToId) ?? "");
    }
  }
  const statusFromOpts =
    typeof options.responseCode === "number" ? options.responseCode : undefined;
  const statusFromParams =
    typeof params.responseCode === "number" ? params.responseCode : undefined;
  return {
    status: statusFromOpts ?? statusFromParams ?? 200,
    body: rewriteDeep(params.responseBody ?? params.responseData ?? {}, nameToId),
    headers,
    respondWith: typeof params.respondWith === "string" ? params.respondWith : "json",
    _n8n: params,
  };
}

function translateEmailSend({ params, nameToId }: Ctx): Params {
  return {
    to: rewriteDeep(params.toEmail ?? params.to ?? "", nameToId),
    from: rewriteDeep(params.fromEmail ?? params.from ?? "", nameToId),
    subject: rewriteDeep(params.subject ?? "", nameToId),
    body: rewriteDeep(params.text ?? params.html ?? params.message ?? "", nameToId),
    html: typeof params.html === "string" ? rewriteDeep(params.html, nameToId) : undefined,
    _n8n: params,
  };
}

function translateSlackWebhook({ params, nameToId }: Ctx): Params {
  // n8n.slack tem várias operations; mapeamos pra webhook genérico.
  const resource = String(params.resource ?? "message");
  const channel = rewriteDeep(params.channel ?? params.channelId ?? "", nameToId);
  const text = rewriteDeep(params.text ?? params.message ?? "", nameToId);
  return {
    resource,
    channel,
    text,
    _n8n: params,
  };
}

function translateDiscordWebhook({ params, nameToId }: Ctx): Params {
  return {
    webhookUrl: rewriteDeep(params.webhookUri ?? params.webhookUrl ?? "", nameToId),
    content: rewriteDeep(params.text ?? params.content ?? "", nameToId),
    _n8n: params,
  };
}

function translateTelegramSend({ params, nameToId }: Ctx): Params {
  return {
    chatId: rewriteDeep(params.chatId ?? "", nameToId),
    text: rewriteDeep(params.text ?? params.message ?? "", nameToId),
    parseMode: typeof params.parseMode === "string" ? params.parseMode : "Markdown",
    _n8n: params,
  };
}

function translateHtmlExtract({ params, nameToId }: Ctx): Params {
  const extractionValues = (params.extractionValues as Params | undefined)?.values;
  const queries: Array<{ key: string; cssSelector: string; returnValue?: string }> = [];
  if (Array.isArray(extractionValues)) {
    for (const raw of extractionValues) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Params;
      if (typeof e.key === "string" && typeof e.cssSelector === "string") {
        queries.push({
          key: e.key,
          cssSelector: e.cssSelector,
          returnValue: typeof e.returnValue === "string" ? e.returnValue : undefined,
        });
      }
    }
  }
  return {
    html: rewriteDeep(params.dataPropertyName ?? params.html ?? "", nameToId),
    queries,
    _n8n: params,
  };
}

function translateMarkdown({ params, nameToId }: Ctx): Params {
  return {
    mode: typeof params.mode === "string" ? params.mode : "markdownToHtml",
    input: rewriteDeep(params.markdown ?? params.html ?? "", nameToId),
    _n8n: params,
  };
}

function translateXml({ params, nameToId }: Ctx): Params {
  return {
    mode: typeof params.mode === "string" ? params.mode : "xmlToJson",
    input: rewriteDeep(params.xml ?? params.dataPropertyName ?? "", nameToId),
    _n8n: params,
  };
}

function translateCsv({ params, nameToId }: Ctx): Params {
  return {
    operation: typeof params.operation === "string" ? params.operation : "fromFile",
    data: rewriteDeep(params.dataPropertyName ?? params.binaryPropertyName ?? "", nameToId),
    _n8n: params,
  };
}

function translatePdfExtract({ params, nameToId }: Ctx): Params {
  return {
    binaryProperty: typeof params.binaryPropertyName === "string" ? params.binaryPropertyName : "data",
    operation: typeof params.operation === "string" ? params.operation : "pdf",
    source: rewriteDeep(params.url ?? "", nameToId),
    _n8n: params,
  };
}

function translateStopAndError({ params, nameToId }: Ctx): Params {
  return {
    errorType: typeof params.errorType === "string" ? params.errorType : "errorMessage",
    message: rewriteDeep(params.errorMessage ?? params.message ?? "Workflow stopped", nameToId),
    _n8n: params,
  };
}

function translateS3({ params, nameToId }: Ctx): Params {
  const operation = String(params.operation ?? "upload");
  return {
    operation,
    bucket: rewriteDeep(params.bucketName ?? params.bucket ?? "", nameToId),
    key: rewriteDeep(params.fileKey ?? params.key ?? "", nameToId),
    region: typeof params.region === "string" ? params.region : "us-east-1",
    _n8n: params,
  };
}

function translateCompression({ params, nameToId }: Ctx): Params {
  return {
    operation: typeof params.operation === "string" ? params.operation : "compress",
    format: typeof params.outputFormat === "string" ? params.outputFormat : "zip",
    binaryProperty: typeof params.binaryPropertyName === "string" ? params.binaryPropertyName : "data",
    source: rewriteDeep(params.fileName ?? "", nameToId),
    _n8n: params,
  };
}

function translateTemplate({ params, nameToId }: Ctx): Params {
  return {
    template: rewriteDeep(params.template ?? "", nameToId),
    data: rewriteDeep(params.data ?? {}, nameToId),
    _n8n: params,
  };
}

function translateYaml({ params, nameToId }: Ctx): Params {
  return {
    mode: typeof params.mode === "string" ? params.mode : "yamlToJson",
    input: rewriteDeep(params.yaml ?? "", nameToId),
    _n8n: params,
  };
}

function translateJwt({ params, nameToId }: Ctx): Params {
  return {
    operation: typeof params.operation === "string" ? params.operation : "verify",
    token: rewriteDeep(params.token ?? "", nameToId),
    secret: rewriteDeep(params.secret ?? "", nameToId),
    payload: rewriteDeep(params.payload ?? {}, nameToId),
    _n8n: params,
  };
}

function translateUrlTools({ params, nameToId }: Ctx): Params {
  return {
    operation: typeof params.operation === "string" ? params.operation : "parse",
    url: rewriteDeep(params.url ?? "", nameToId),
    _n8n: params,
  };
}

function translateUuid(): Params {
  return {};
}

function translateRandom({ params }: Ctx): Params {
  return {
    min: Number(params.min ?? 0),
    max: Number(params.max ?? 100),
    integer: params.integer !== false,
  };
}

function translateMath({ params, nameToId }: Ctx): Params {
  return {
    expression: rewriteDeep(params.expression ?? params.formula ?? "", nameToId),
    _n8n: params,
  };
}

function translateShuffle({ params, nameToId }: Ctx): Params {
  return { items: rewriteDeep(params.items ?? [], nameToId) };
}

function translateTransform({ params, nameToId }: Ctx): Params {
  return {
    code: rewriteDeep(params.code ?? params.jsCode ?? "", nameToId),
    _n8n: params,
  };
}

function translateTextManipulation({ params, nameToId }: Ctx): Params {
  return {
    operation: typeof params.operation === "string" ? params.operation : "concat",
    input: rewriteDeep(params.text ?? params.input ?? "", nameToId),
    _n8n: params,
  };
}

function translateJson({ params, nameToId }: Ctx): Params {
  return {
    mode: typeof params.mode === "string" ? params.mode : "stringify",
    input: rewriteDeep(params.json ?? params.string ?? "", nameToId),
    _n8n: params,
  };
}

function translateAiAgent(ctx: Ctx): Params {
  // ai_agent é variante mais sofisticada de ai_chat — reusa tradutor.
  return translateAiChat(ctx);
}

function translateContainer({ params }: Ctx): Params {
  return {
    label: typeof params.label === "string" ? params.label : "",
    _n8n: params,
  };
}

function translateWebsocket({ params, nameToId }: Ctx): Params {
  return {
    url: rewriteDeep(params.url ?? "", nameToId),
    operation: typeof params.operation === "string" ? params.operation : "send",
    message: rewriteDeep(params.message ?? "", nameToId),
    _n8n: params,
  };
}

function translateGenericNoop({ params }: Ctx): Params {
  // Catch-all pra tipos LangChain "sub-nodes" (tools, parsers, splitters)
  // que não têm equivalente direto no engine — preservamos e o usuário
  // pluga manualmente onde fizer sentido.
  return { _n8n: params, _preserved: true };
}

// ── dispatch ───────────────────────────────────────────────────────────
/**
 * Tipos que o importer sabe mapear. Fonte única — `n8n-import.ts` reusa esse tipo
 * em vez de duplicar a união, então adicionar entrada no TYPE_MAP de lá força
 * registro do tradutor aqui (typecheck garante).
 */
export type MappedType =
  | "start"
  | "webhook_trigger"
  | "set_variable"
  | "http_request"
  | "if"
  | "filter"
  | "ai_chat"
  | "ai_agent"
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
  | "sticky_note"
  | "container"
  | "date_time"
  | "crypto"
  | "item_lists"
  | "aggregate"
  | "execute_workflow"
  | "merge"
  | "split_out"
  | "rename_keys"
  | "sort"
  | "limit"
  | "remove_duplicates"
  | "compare_datasets"
  | "edit_fields"
  | "schedule_trigger"
  | "interval_trigger"
  | "manual_trigger"
  | "error_trigger"
  | "rss_trigger"
  | "email_trigger"
  | "form_trigger"
  | "respond_to_webhook"
  | "email_send"
  | "slack_webhook"
  | "discord_webhook"
  | "telegram_send"
  | "html_extract"
  | "markdown"
  | "xml"
  | "csv"
  | "pdf_extract"
  | "stop_and_error"
  | "s3"
  | "compression"
  | "template"
  | "yaml"
  | "jwt"
  | "url_tools"
  | "uuid"
  | "random"
  | "math"
  | "shuffle"
  | "transform"
  | "text_manipulation"
  | "json"
  | "websocket";

const TRANSLATORS: Record<MappedType, (ctx: Ctx) => Params> = {
  start: translateStart,
  // Webhook trigger usa o mesmo translator do start (params idênticos: path,
  // httpMethod, etc; é só a UI que ganha o painel completo com URL/teste).
  webhook_trigger: translateStart,
  noop: translateNoop,
  set_variable: translateSet,
  edit_fields: translateSet,
  if: translateIf,
  filter: translateFilter,
  wait: translateWait,
  http_request: translateHttpRequest,
  redis: translateRedis,
  postgres: translatePostgres,
  switch: translateSwitch,
  ai_chat: translateAiChat,
  ai_agent: translateAiAgent,
  code: translateCode,
  split_in_batches: translateSplitInBatches,
  embeddings: translateEmbeddings,
  vector_store: translateVectorStore,
  chat_memory: translateChatMemory,
  document_loader: translateDocumentLoader,
  sticky_note: translateStickyNote,
  container: translateContainer,
  date_time: translateDateTime,
  crypto: translateCrypto,
  item_lists: translateItemLists,
  aggregate: translateAggregate,
  execute_workflow: translateExecuteWorkflow,
  merge: translateMerge,
  split_out: translateSplitOut,
  rename_keys: translateRenameKeys,
  sort: translateSort,
  limit: translateLimit,
  remove_duplicates: translateRemoveDuplicates,
  compare_datasets: translateCompareDatasets,
  schedule_trigger: translateScheduleTrigger,
  interval_trigger: translateIntervalTrigger,
  manual_trigger: translateManualTrigger,
  error_trigger: translateErrorTrigger,
  rss_trigger: translateRssTrigger,
  email_trigger: translateEmailTrigger,
  form_trigger: translateFormTrigger,
  respond_to_webhook: translateRespondToWebhook,
  email_send: translateEmailSend,
  slack_webhook: translateSlackWebhook,
  discord_webhook: translateDiscordWebhook,
  telegram_send: translateTelegramSend,
  html_extract: translateHtmlExtract,
  markdown: translateMarkdown,
  xml: translateXml,
  csv: translateCsv,
  pdf_extract: translatePdfExtract,
  stop_and_error: translateStopAndError,
  s3: translateS3,
  compression: translateCompression,
  template: translateTemplate,
  yaml: translateYaml,
  jwt: translateJwt,
  url_tools: translateUrlTools,
  uuid: translateUuid,
  random: translateRandom,
  math: translateMath,
  shuffle: translateShuffle,
  transform: translateTransform,
  text_manipulation: translateTextManipulation,
  json: translateJson,
  websocket: translateWebsocket,
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
  const translator = TRANSLATORS[mappedType] ?? translateGenericNoop;
  const config = translator({ params, nameToId });
  if (!("_n8n" in config)) config._n8n = params;
  return config;
}
