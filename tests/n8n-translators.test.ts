/**
 * Unit tests puros da tradução de workflows do n8n — sem DB, sem testcontainers.
 *
 * Cobre os dois lados do importer:
 *  - `n8n-translators.ts`: o rewriter de expressões (`rewriteExpr`/`rewriteDeep`)
 *    e cada tradutor registrado em TRANSLATORS (um teste por tradutor, com um
 *    node n8n realista de entrada), mais o fallback de tipo desconhecido.
 *  - `n8n-import.ts`: `importN8nWorkflow` — mapeamento de tipos, edges
 *    (if/filter/switch), normalização de posição, pinData, tags e erros.
 *
 * IMPORTANTE: os testes afirmam o comportamento ATUAL do código, inclusive onde
 * ele diverge do docstring (ver bloco "comportamento divergente do docstring").
 */
import { describe, expect, test } from "bun:test";
import { type ImportResult, importN8nWorkflow } from "../src/features/workflows/n8n-import";
import {
  type MappedType,
  rewriteDeep,
  rewriteExpr,
  translateN8nParameters,
} from "../src/features/workflows/n8n-translators";

/** Mapa name→id usado pelos testes que resolvem referências a outros nós. */
function nameMap(entries: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries(entries));
}

/** Atalho: roda o dispatcher com um mapa vazio por padrão. */
function tr(
  type: MappedType,
  params: Record<string, unknown>,
  names: Record<string, string> = {},
): Record<string, unknown> {
  return translateN8nParameters(type, params, nameMap(names));
}

// ══════════════════════════════════════════════════════════════════════════
// rewriteExpr — reescrita de expressões (lógica crítica)
// ══════════════════════════════════════════════════════════════════════════

describe("rewriteExpr — prefixo de expressão", () => {
  test("remove o `=` que o n8n usa pra marcar strings de expressão", () => {
    // Arrange / Act
    const out = rewriteExpr("={{ $json.nome }}", nameMap());

    // Assert
    expect(out).toBe("{{ prev.nome }}");
  });

  test("string literal sem `=` passa intacta", () => {
    expect(rewriteExpr("texto puro", nameMap())).toBe("texto puro");
  });

  test("string vazia continua vazia", () => {
    expect(rewriteExpr("", nameMap())).toBe("");
  });
});

describe("rewriteExpr — $json → prev", () => {
  test("`{{ $json.X }}` vira `{{ prev.X }}`", () => {
    expect(rewriteExpr("={{ $json.email }}", nameMap())).toBe("{{ prev.email }}");
  });

  test("caminho aninhado `$json.a.b.c` preserva o path inteiro", () => {
    expect(rewriteExpr("={{ $json.user.address.city }}", nameMap())).toBe(
      "{{ prev.user.address.city }}",
    );
  });

  test("índice de array `$json.items[0].id` é preservado", () => {
    expect(rewriteExpr("={{ $json.items[0].id }}", nameMap())).toBe("{{ prev.items[0].id }}");
  });

  test("acesso por colchetes `$json['chave com espaço']` vira `prev['chave com espaço']`", () => {
    expect(rewriteExpr("={{ $json['conversação IA'] }}", nameMap())).toBe(
      "{{ prev['conversação IA'] }}",
    );
  });

  test("múltiplas ocorrências na mesma string são todas reescritas", () => {
    expect(rewriteExpr("={{ $json.a }}-{{ $json.b }}", nameMap())).toBe("{{ prev.a }}-{{ prev.b }}");
  });
});

describe("rewriteExpr — referências a outros nós → steps.<id>", () => {
  const names = { "Buscar Cliente": "node-abc" };

  test("`$('Nome').item.json.X` resolve pro id do nó", () => {
    expect(rewriteExpr("={{ $('Buscar Cliente').item.json.cpf }}", nameMap(names))).toBe(
      "{{ steps.node-abc.cpf }}",
    );
  });

  test("`$('Nome').first().json.X` resolve pro id do nó", () => {
    expect(rewriteExpr("={{ $('Buscar Cliente').first().json.cpf }}", nameMap(names))).toBe(
      "{{ steps.node-abc.cpf }}",
    );
  });

  test("`$('Nome').last().json.X` resolve pro id do nó", () => {
    expect(rewriteExpr("={{ $('Buscar Cliente').last().json.cpf }}", nameMap(names))).toBe(
      "{{ steps.node-abc.cpf }}",
    );
  });

  test("`$('Nome').all()` vira `steps.<id>` (sem path)", () => {
    expect(rewriteExpr("={{ $('Buscar Cliente').all() }}", nameMap(names))).toBe(
      "{{ steps.node-abc }}",
    );
  });

  test("`$node[\"Nome\"].json.X` (sintaxe legada) resolve pro id", () => {
    expect(rewriteExpr('={{ $node["Buscar Cliente"].json.cpf }}', nameMap(names))).toBe(
      "{{ steps.node-abc.cpf }}",
    );
  });

  test("`$node.Nome.json.X` (shorthand, nome sem espaços) resolve pro id", () => {
    expect(rewriteExpr("={{ $node.Webhook.json.body }}", nameMap({ Webhook: "wh-1" }))).toBe(
      "{{ steps.wh-1.body }}",
    );
  });

  test("nó desconhecido no mapa mantém a expressão original (não inventa id)", () => {
    // Arrange: mapa vazio — o nó "Fantasma" não existe.
    const out = rewriteExpr("={{ $('Fantasma').item.json.x }}", nameMap());

    // Assert: o trecho fica intacto pro usuário corrigir manualmente.
    expect(out).toBe("{{ $('Fantasma').item.json.x }}");
  });
});

describe("rewriteExpr — $input / $items → input", () => {
  test("`$input.item.json.X` vira `input.X`", () => {
    expect(rewriteExpr("={{ $input.item.json.nome }}", nameMap())).toBe("{{ input.nome }}");
  });

  test("`$input.first().json.X` vira `input.X`", () => {
    expect(rewriteExpr("={{ $input.first().json.nome }}", nameMap())).toBe("{{ input.nome }}");
  });

  test("`$input.all()` vira `input`", () => {
    expect(rewriteExpr("={{ $input.all() }}", nameMap())).toBe("{{ input }}");
  });

  test("`$items()` vira `input`", () => {
    expect(rewriteExpr("={{ $items() }}", nameMap())).toBe("{{ input }}");
  });
});

describe("rewriteExpr — vars / env / prevNode", () => {
  test("`$vars.X` vira `vars.X`", () => {
    expect(rewriteExpr("={{ $vars.apiBase }}", nameMap())).toBe("{{ vars.apiBase }}");
  });

  test("`$env.X` vira `env.X`", () => {
    expect(rewriteExpr("={{ $env.API_KEY }}", nameMap())).toBe("{{ env.API_KEY }}");
  });

  test("`$prevNode.X` vira `prev.X`", () => {
    expect(rewriteExpr("={{ $prevNode.saida }}", nameMap())).toBe("{{ prev.saida }}");
  });
});

describe("rewriteExpr — comportamento divergente do docstring (globais)", () => {
  // O docstring do módulo promete `$now → {{$now}}` e `$execution.id →
  // {{$execution.id}}`, mas as substituições (n8n-translators.ts:104-107)
  // trocam o padrão por ele mesmo — são no-ops. Testes fixam o comportamento
  // REAL para que uma correção futura falhe aqui de propósito.
  test("`$now` permanece `$now` (substituição é no-op)", () => {
    expect(rewriteExpr("={{ $now }}", nameMap())).toBe("{{ $now }}");
  });

  test("`$today` permanece `$today` (substituição é no-op)", () => {
    expect(rewriteExpr("={{ $today }}", nameMap())).toBe("{{ $today }}");
  });

  test("`$execution.id` permanece `$execution.id` (substituição é no-op)", () => {
    expect(rewriteExpr("={{ $execution.id }}", nameMap())).toBe("{{ $execution.id }}");
  });

  test("`$workflow.id` permanece `$workflow.id` (substituição é no-op)", () => {
    expect(rewriteExpr("={{ $workflow.id }}", nameMap())).toBe("{{ $workflow.id }}");
  });
});

describe("rewriteDeep — travessia recursiva", () => {
  test("string solta é reescrita", () => {
    expect(rewriteDeep("={{ $json.a }}", nameMap())).toBe("{{ prev.a }}");
  });

  test("array reescreve cada elemento", () => {
    expect(rewriteDeep(["={{ $json.a }}", "literal"], nameMap())).toEqual([
      "{{ prev.a }}",
      "literal",
    ]);
  });

  test("objeto aninhado reescreve valores em qualquer profundidade", () => {
    // Arrange
    const input = { a: { b: ["={{ $json.x }}", { c: "={{ $vars.y }}" }] } };

    // Act
    const out = rewriteDeep(input, nameMap());

    // Assert
    expect(out).toEqual({ a: { b: ["{{ prev.x }}", { c: "{{ vars.y }}" }] } });
  });

  test("chaves do objeto NÃO são reescritas (só os valores)", () => {
    expect(rewriteDeep({ "$json.a": "={{ $json.b }}" }, nameMap())).toEqual({
      "$json.a": "{{ prev.b }}",
    });
  });

  test("primitivos não-string passam intactos (number/boolean/null)", () => {
    expect(rewriteDeep(42, nameMap())).toBe(42);
    expect(rewriteDeep(true, nameMap())).toBe(true);
    expect(rewriteDeep(null, nameMap())).toBe(null);
    expect(rewriteDeep(undefined, nameMap())).toBe(undefined);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// translateN8nParameters — contrato geral do dispatcher
// ══════════════════════════════════════════════════════════════════════════

describe("translateN8nParameters — contrato geral", () => {
  test("sempre injeta `_n8n` com os parameters crus quando o tradutor não o define", () => {
    // Arrange / Act
    const cfg = tr("code", { jsCode: "return 1;" });

    // Assert
    expect(cfg._n8n).toEqual({ jsCode: "return 1;" });
  });

  test("tradutor que já devolve `_n8n` não é sobrescrito", () => {
    // Arrange: translateVectorStore injeta `_n8n` com uma `_note` extra.
    const cfg = tr("vector_store", { mode: "insert" });

    // Assert
    expect((cfg._n8n as Record<string, unknown>)._note).toBe(
      "ligue embedding/content/metadata manualmente",
    );
  });

  test("parameters undefined é tratado como objeto vazio", () => {
    expect(tr("noop", {} as Record<string, unknown>)).toEqual({ _n8n: {} });
    expect(translateN8nParameters("noop", undefined, nameMap())).toEqual({ _n8n: {} });
  });

  test("tipo desconhecido cai no fallback genérico preservando os parameters", () => {
    // Arrange: força um tipo fora da união MappedType.
    const params = { qualquer: "coisa" };

    // Act
    const cfg = translateN8nParameters("tipo_inexistente" as MappedType, params, nameMap());

    // Assert: catch-all preserva tudo e marca `_preserved`.
    expect(cfg).toEqual({ _n8n: { qualquer: "coisa" }, _preserved: true });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Tradutores — triggers
// ══════════════════════════════════════════════════════════════════════════

describe("tradutores — triggers", () => {
  test("start preserva os parameters crus em `_n8n`", () => {
    expect(tr("start", { path: "/hook", httpMethod: "POST" })).toEqual({
      _n8n: { path: "/hook", httpMethod: "POST" },
    });
  });

  test("webhook_trigger usa o mesmo tradutor do start", () => {
    // Arrange
    const params = { path: "abc-123", httpMethod: "POST", responseMode: "responseNode" };

    // Assert: shape idêntico ao de `start`.
    expect(tr("webhook_trigger", params)).toEqual(tr("start", params));
  });

  test("manual_trigger só preserva os parameters", () => {
    expect(tr("manual_trigger", {})).toEqual({ _n8n: {} });
  });

  test("error_trigger só preserva os parameters", () => {
    expect(tr("error_trigger", {})).toEqual({ _n8n: {} });
  });

  test("schedule_trigger com cronExpression usa a expressão do n8n", () => {
    // Arrange: shape real do scheduleTrigger com cron custom.
    const params = { rule: { interval: [{ field: "cronExpression", expression: "0 9 * * 1-5" }] } };

    // Act
    const cfg = tr("schedule_trigger", params);

    // Assert
    expect(cfg.cronExpression).toBe("0 9 * * 1-5");
    expect(cfg.timezone).toBe("UTC");
  });

  test("schedule_trigger por hoursInterval gera cron equivalente", () => {
    const cfg = tr("schedule_trigger", { rule: { interval: [{ field: "hours", hoursInterval: 6 }] } });
    expect(cfg.cronExpression).toBe("0 */6 * * *");
  });

  test("schedule_trigger por minutesInterval gera cron equivalente", () => {
    const cfg = tr("schedule_trigger", {
      rule: { interval: [{ field: "minutes", minutesInterval: 15 }] },
    });
    expect(cfg.cronExpression).toBe("*/15 * * * *");
  });

  test("schedule_trigger sem rule cai no default de hora em hora", () => {
    expect(tr("schedule_trigger", {}).cronExpression).toBe("0 * * * *");
  });

  test("interval_trigger converte unidade em segundos", () => {
    expect(tr("interval_trigger", { interval: 5, unit: "minutes" }).intervalSeconds).toBe(300);
    expect(tr("interval_trigger", { interval: 2, unit: "hours" }).intervalSeconds).toBe(7200);
    expect(tr("interval_trigger", { interval: 30, unit: "seconds" }).intervalSeconds).toBe(30);
  });

  test("interval_trigger sem params usa 60s", () => {
    expect(tr("interval_trigger", {}).intervalSeconds).toBe(60);
  });

  test("rss_trigger extrai feedUrl e fixa poll de 1h", () => {
    // Act
    const cfg = tr("rss_trigger", { feedUrl: "https://blog.exemplo.com/rss", pollTimes: {} });

    // Assert
    expect(cfg.feedUrl).toBe("https://blog.exemplo.com/rss");
    expect(cfg.pollIntervalSeconds).toBe(3600);
  });

  test("email_trigger (IMAP) aplica defaults de porta/segurança/mailbox", () => {
    // Act
    const cfg = tr("email_trigger", { host: "imap.exemplo.com" });

    // Assert
    expect(cfg).toMatchObject({
      host: "imap.exemplo.com",
      port: 993,
      secure: true,
      mailbox: "INBOX",
    });
  });

  test("email_trigger respeita secure:false explícito", () => {
    expect(tr("email_trigger", { host: "h", secure: false, port: 143 })).toMatchObject({
      secure: false,
      port: 143,
    });
  });

  test("form_trigger extrai título, descrição e campos", () => {
    // Arrange: shape real do n8nFormTrigger.
    const params = {
      formTitle: "Cadastro",
      formDescription: "Preencha seus dados",
      formFields: { values: [{ fieldLabel: "Nome", fieldType: "text", requiredField: true }] },
    };

    // Act
    const cfg = tr("form_trigger", params);

    // Assert
    expect(cfg.formTitle).toBe("Cadastro");
    expect(cfg.formDescription).toBe("Preencha seus dados");
    expect(cfg.fields).toEqual([{ fieldLabel: "Nome", fieldType: "text", requiredField: true }]);
  });

  test("form_trigger sem campos devolve lista vazia", () => {
    expect(tr("form_trigger", {})).toMatchObject({ formTitle: "", formDescription: "", fields: [] });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Tradutores — controle de fluxo
// ══════════════════════════════════════════════════════════════════════════

describe("tradutores — if / filter", () => {
  test("if v2 traduz leftValue/operator/rightValue e reescreve a expressão", () => {
    // Arrange: shape real do n8n-nodes-base.if typeVersion 2.
    const params = {
      conditions: {
        conditions: [
          {
            leftValue: "={{ $json.total }}",
            rightValue: 100,
            operator: { operation: "gt", type: "number" },
          },
        ],
      },
    };

    // Act
    const cfg = tr("if", params);

    // Assert
    expect(cfg).toMatchObject({ left: "{{ prev.total }}", op: "gt", right: 100, dataType: "number" });
  });

  test("if v2 mapeia os operadores textuais do n8n pra enum interna", () => {
    const build = (operation: string) => ({
      conditions: { conditions: [{ leftValue: "a", rightValue: "b", operator: { operation } }] },
    });

    expect(tr("if", build("equals")).op).toBe("eq");
    expect(tr("if", build("notEquals")).op).toBe("neq");
    expect(tr("if", build("contains")).op).toBe("contains");
    expect(tr("if", build("notContains")).op).toBe("ncontains");
    expect(tr("if", build("startsWith")).op).toBe("startsWith");
    expect(tr("if", build("endsWith")).op).toBe("endsWith");
    expect(tr("if", build("regex")).op).toBe("regex");
    expect(tr("if", build("isEmpty")).op).toBe("falsy");
    expect(tr("if", build("notEmpty")).op).toBe("truthy");
    expect(tr("if", build("gte")).op).toBe("gte");
    expect(tr("if", build("greaterEqual")).op).toBe("gte");
    expect(tr("if", build("less")).op).toBe("lt");
    expect(tr("if", build("lessEqual")).op).toBe("lte");
  });

  test("if v2 com operador desconhecido cai em `eq`", () => {
    const cfg = tr("if", {
      conditions: { conditions: [{ leftValue: "a", rightValue: "b", operator: { operation: "xyz" } }] },
    });
    expect(cfg.op).toBe("eq");
  });

  test("if v2 usa apenas a PRIMEIRA condição (demais são descartadas)", () => {
    // Arrange: duas condições — o engine interno só suporta uma.
    const params = {
      conditions: {
        conditions: [
          { leftValue: "={{ $json.a }}", rightValue: 1, operator: { operation: "equals" } },
          { leftValue: "={{ $json.b }}", rightValue: 2, operator: { operation: "equals" } },
        ],
      },
    };

    // Act
    const cfg = tr("if", params);

    // Assert: só a primeira sobrevive; a segunda só existe em `_n8n`.
    expect(cfg.left).toBe("{{ prev.a }}");
    expect(cfg.right).toBe(1);
  });

  test("if v1 (conditions.string[]) traduz value1/value2/operation com dataType", () => {
    // Arrange: shape legado v1.
    const params = {
      conditions: { string: [{ value1: "={{ $json.nome }}", operation: "contains", value2: "ada" }] },
    };

    // Act
    const cfg = tr("if", params);

    // Assert
    expect(cfg).toMatchObject({
      left: "{{ prev.nome }}",
      op: "contains",
      right: "ada",
      dataType: "string",
    });
  });

  test("if v1 sem `operation` assume equals", () => {
    const cfg = tr("if", { conditions: { number: [{ value1: 1, value2: 1 }] } });
    expect(cfg).toMatchObject({ op: "eq", dataType: "number" });
  });

  test("if v1 boolean e dateTime carregam o dataType correspondente", () => {
    expect(tr("if", { conditions: { boolean: [{ value1: true, value2: true }] } }).dataType).toBe(
      "boolean",
    );
    expect(
      tr("if", { conditions: { dateTime: [{ value1: "2026-01-01", value2: "2026-02-01" }] } })
        .dataType,
    ).toBe("dateTime");
  });

  test("if sem conditions reconhecíveis preserva tudo em `_n8n`", () => {
    expect(tr("if", { coisa: 1 })).toEqual({ _n8n: { coisa: 1 } });
  });

  test("filter reusa exatamente o tradutor do if", () => {
    // Arrange
    const params = {
      conditions: {
        conditions: [{ leftValue: "={{ $json.ativo }}", rightValue: true, operator: { operation: "equals" } }],
      },
    };

    // Assert
    expect(tr("filter", params)).toEqual(tr("if", params));
  });
});

describe("tradutores — switch", () => {
  test("extrai `value` da 1ª condição e um case por regra", () => {
    // Arrange: shape real do switch v3 com duas saídas.
    const params = {
      rules: {
        values: [
          {
            conditions: {
              conditions: [
                { leftValue: "={{ $json.status }}", rightValue: "pago", operator: { operation: "equals" } },
              ],
            },
          },
          {
            conditions: {
              conditions: [
                { leftValue: "={{ $json.status }}", rightValue: "falhou", operator: { operation: "equals" } },
              ],
            },
          },
        ],
      },
    };

    // Act
    const cfg = tr("switch", params);

    // Assert: `value` vem da 1ª regra; labels são os índices em string.
    expect(cfg.value).toBe("{{ prev.status }}");
    expect(cfg.cases).toEqual([
      { match: "pago", label: "0" },
      { match: "falhou", label: "1" },
    ]);
    expect(cfg.default).toBe("default");
  });

  test("switch sem regras devolve cases vazio e preserva `_n8n`", () => {
    expect(tr("switch", { rules: { values: [] } })).toEqual({
      value: "",
      cases: [],
      _n8n: { rules: { values: [] } },
    });
  });
});

describe("tradutores — wait", () => {
  test("resume=specificTime vira `until`", () => {
    expect(tr("wait", { resume: "specificTime", dateTime: "2026-12-25T10:00:00" })).toMatchObject({
      until: "2026-12-25T10:00:00",
    });
  });

  test("resume=webhook marca waitForWebhook", () => {
    expect(tr("wait", { resume: "webhook", webhookId: "x" })).toMatchObject({
      waitForWebhook: true,
    });
  });

  test("amount + unit convertem pra segundos", () => {
    expect(tr("wait", { amount: 5, unit: "minutes" }).seconds).toBe(300);
    expect(tr("wait", { amount: 2, unit: "hours" }).seconds).toBe(7200);
    expect(tr("wait", { amount: 1, unit: "days" }).seconds).toBe(86400);
    expect(tr("wait", { amount: 45, unit: "seconds" }).seconds).toBe(45);
  });

  test("amount como string (expressão resolvida) é parseado", () => {
    expect(tr("wait", { amount: "1.5", unit: "minutes" }).seconds).toBe(90);
  });

  test("sem amount usa 1 segundo", () => {
    expect(tr("wait", {}).seconds).toBe(1);
  });

  test("amount não-numérico cai no fallback de 1 segundo", () => {
    expect(tr("wait", { amount: "abc", unit: "hours" })).toEqual({
      seconds: 1,
      _n8n: { amount: "abc", unit: "hours" },
    });
  });
});

describe("tradutores — merge / split / batches / execute", () => {
  test("merge preserva o mode do n8n", () => {
    expect(tr("merge", { mode: "combine", combineBy: "combineByPosition" })).toMatchObject({
      mode: "combine",
    });
  });

  test("merge sem mode assume append", () => {
    expect(tr("merge", {}).mode).toBe("append");
  });

  test("split_out extrai o campo a explodir", () => {
    expect(tr("split_out", { fieldToSplitOut: "data.items" })).toMatchObject({
      field: "data.items",
      items: "data.items",
    });
  });

  test("split_in_batches usa batchSize numérico", () => {
    expect(tr("split_in_batches", { batchSize: 25 })).toMatchObject({ batchSize: 25, items: [] });
  });

  test("split_in_batches parseia batchSize vindo como string", () => {
    expect(tr("split_in_batches", { batchSize: "10" }).batchSize).toBe(10);
  });

  test("split_in_batches com batchSize inválido/zero cai em 1", () => {
    expect(tr("split_in_batches", { batchSize: 0 }).batchSize).toBe(1);
    expect(tr("split_in_batches", { batchSize: "abc" }).batchSize).toBe(1);
    expect(tr("split_in_batches", {}).batchSize).toBe(1);
  });

  test("execute_workflow com workflowId string", () => {
    expect(tr("execute_workflow", { workflowId: "wf-123" })).toMatchObject({ workflowId: "wf-123" });
  });

  test("execute_workflow com workflowId resource locator ({ value })", () => {
    // Arrange: o n8n moderno manda um resource locator.
    const params = {
      workflowId: { __rl: true, value: "abc-uuid", mode: "list", cachedResultName: "Sub" },
      workflowInputs: { valor: "={{ $json.total }}" },
    };

    // Act
    const cfg = tr("execute_workflow", params);

    // Assert
    expect(cfg.workflowId).toBe("abc-uuid");
    expect(cfg.input).toEqual({ valor: "{{ prev.total }}" });
    expect(cfg._n8n_note).toContain("workflowId");
  });

  test("execute_workflow sem workflowId devolve string vazia", () => {
    expect(tr("execute_workflow", {})).toMatchObject({ workflowId: "", input: {} });
  });

  test("stop_and_error traduz mensagem de erro", () => {
    expect(tr("stop_and_error", { errorMessage: "={{ $json.msg }}" })).toMatchObject({
      errorType: "errorMessage",
      message: "{{ prev.msg }}",
    });
  });

  test("stop_and_error sem mensagem usa default", () => {
    expect(tr("stop_and_error", {}).message).toBe("Workflow stopped");
  });

  test("noop devolve config vazia (só `_n8n`)", () => {
    expect(tr("noop", { qualquer: 1 })).toEqual({ _n8n: { qualquer: 1 } });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Tradutores — set / edit_fields
// ══════════════════════════════════════════════════════════════════════════

describe("tradutores — set / edit_fields", () => {
  test("assignments v3 viram `variables` + `_types` com expressões reescritas", () => {
    // Arrange: shape real do editFields/set v3.
    const params = {
      assignments: {
        assignments: [
          { id: "1", name: "nome", value: "={{ $json.cliente.nome }}", type: "string" },
          { id: "2", name: "ai_enabled", value: "={{ $json.flags.ai }}", type: "boolean" },
        ],
      },
    };

    // Act
    const cfg = tr("set_variable", params);

    // Assert: `_types` preserva o tipo n8n pro engine coagir em runtime.
    expect(cfg.variables).toEqual({
      nome: "{{ prev.cliente.nome }}",
      ai_enabled: "{{ prev.flags.ai }}",
    });
    expect(cfg._types).toEqual({ nome: "string", ai_enabled: "boolean" });
  });

  test("edit_fields usa exatamente o mesmo tradutor do set_variable", () => {
    const params = {
      assignments: { assignments: [{ name: "x", value: "1", type: "number" }] },
    };
    expect(tr("edit_fields", params)).toEqual(tr("set_variable", params));
  });

  test("assignments sem `type` omitem `_types`", () => {
    const cfg = tr("set_variable", { assignments: { assignments: [{ name: "x", value: "1" }] } });
    expect(cfg.variables).toEqual({ x: "1" });
    expect(cfg).not.toHaveProperty("_types");
  });

  test("assignments sem `name` são ignorados", () => {
    const cfg = tr("set_variable", {
      assignments: { assignments: [{ value: "sem nome" }, null, "lixo", { name: "ok", value: 1 }] },
    });
    expect(cfg.variables).toEqual({ ok: 1 });
  });

  test("set legado (values.string[]) vira `variables` sem `_types`", () => {
    // Arrange: shape v1 do n8n-nodes-base.set.
    const params = { values: { string: [{ name: "saudacao", value: "={{ $json.nome }}" }] } };

    // Act
    const cfg = tr("set_variable", params);

    // Assert
    expect(cfg.variables).toEqual({ saudacao: "{{ prev.nome }}" });
    expect(cfg).not.toHaveProperty("_types");
  });

  test("set legado só com values.number[] também é traduzido", () => {
    expect(tr("set_variable", { values: { number: [{ name: "qtd", value: 7 }] } }).variables).toEqual(
      { qtd: 7 },
    );
  });

  test("BUG CONHECIDO: set legado com string[] E number[] descarta os números", () => {
    // n8n-translators.ts:183-185 faz `values.string ?? values.number`, então
    // quando o nó legado tem os dois arrays só o primeiro é lido — os campos
    // numéricos (e os booleanos, nunca lidos) somem silenciosamente.
    // Teste fixa o comportamento ATUAL, não o desejado.
    const cfg = tr("set_variable", {
      values: {
        string: [{ name: "nome", value: "ada" }],
        number: [{ name: "idade", value: 30 }],
        boolean: [{ name: "ativo", value: true }],
      },
    });

    expect(cfg.variables).toEqual({ nome: "ada" });
    expect(cfg.variables).not.toHaveProperty("idade");
    expect(cfg.variables).not.toHaveProperty("ativo");
  });

  test("set sem assignments nem values preserva tudo em `_n8n`", () => {
    expect(tr("set_variable", { modoEstranho: true })).toEqual({ _n8n: { modoEstranho: true } });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Tradutores — HTTP / rede
// ══════════════════════════════════════════════════════════════════════════

describe("tradutores — http_request", () => {
  test("nó completo traduz url/method/headers/query/body/timeout/auth", () => {
    // Arrange: nó httpRequest v4 realista.
    const params = {
      method: "POST",
      url: "={{ $json.baseUrl }}/clientes",
      authentication: "genericCredentialType",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "Content-Type", value: "application/json" },
          { name: "X-Trace", value: "={{ $json.traceId }}" },
        ],
      },
      sendQuery: true,
      queryParameters: { parameters: [{ name: "page", value: "={{ $json.page }}" }] },
      sendBody: true,
      jsonBody: '={"nome": "{{ $json.nome }}"}',
      options: { timeout: 15000 },
    };

    // Act
    const cfg = tr("http_request", params);

    // Assert
    expect(cfg.url).toBe("{{ prev.baseUrl }}/clientes");
    expect(cfg.method).toBe("POST");
    expect(cfg.headers).toEqual({
      "Content-Type": "application/json",
      "X-Trace": "{{ prev.traceId }}",
    });
    expect(cfg.query).toEqual({ page: "{{ prev.page }}" });
    expect(cfg.body).toBe('{"nome": "{{ prev.nome }}"}');
    expect(cfg.timeoutMs).toBe(15000);
    expect(cfg.auth).toBe("genericCredentialType");
  });

  test("GET simples só devolve url e method (sem chaves vazias)", () => {
    // Act
    const cfg = tr("http_request", { url: "https://api.exemplo.com/ping" });

    // Assert: method default GET; headers/query/body omitidos.
    expect(cfg).toEqual({
      url: "https://api.exemplo.com/ping",
      method: "GET",
      _n8n: { url: "https://api.exemplo.com/ping" },
    });
  });

  test("authentication=none não vira `auth`", () => {
    expect(tr("http_request", { url: "u", authentication: "none" })).not.toHaveProperty("auth");
  });

  test("body via bodyParameters vira objeto chave-valor", () => {
    // Arrange
    const params = {
      sendBody: true,
      bodyParameters: {
        parameters: [
          { name: "id", value: "={{ $json.id }}" },
          { name: "fixo", value: "abc" },
        ],
      },
      url: "u",
    };

    // Act / Assert
    expect(tr("http_request", params).body).toEqual({ id: "{{ prev.id }}", fixo: "abc" });
  });

  test("sendBody ausente não gera body mesmo com bodyParameters presentes", () => {
    expect(
      tr("http_request", { url: "u", bodyParameters: { parameters: [{ name: "a", value: 1 }] } }),
    ).not.toHaveProperty("body");
  });

  test("headers sem `value` são descartados", () => {
    const cfg = tr("http_request", {
      url: "u",
      headerParameters: { parameters: [{ name: "Vazio" }, { name: "Ok", value: "1" }] },
    });
    expect(cfg.headers).toEqual({ Ok: "1" });
  });
});

describe("tradutores — respond_to_webhook", () => {
  test("converte responseHeaders.entries[] em Record e responseCode em status", () => {
    // Arrange: shape real do respondToWebhook.
    const params = {
      respondWith: "json",
      responseBody: '={{ JSON.stringify({ ok: true, id: $json.id }) }}',
      options: {
        responseCode: 201,
        responseHeaders: { entries: [{ name: "X-Req", value: "={{ $json.reqId }}" }] },
      },
    };

    // Act
    const cfg = tr("respond_to_webhook", params);

    // Assert
    expect(cfg.status).toBe(201);
    expect(cfg.headers).toEqual({ "X-Req": "{{ prev.reqId }}" });
    expect(cfg.respondWith).toBe("json");
    expect(cfg.body).toContain("prev.id");
  });

  test("responseCode no top-level também vira status", () => {
    expect(tr("respond_to_webhook", { responseCode: 404 }).status).toBe(404);
  });

  test("sem responseCode assume 200 e headers vazio", () => {
    expect(tr("respond_to_webhook", {})).toMatchObject({ status: 200, headers: {}, body: {} });
  });

  test("BUG CONHECIDO: responseHeaders como Record (sem `entries`) é descartado", () => {
    // n8n-translators.ts:810-826 — o `?? []` da linha 811 já resolve o caso
    // "sem entries" pra array vazio, então o ramo `else if (headersRaw &&
    // typeof headersRaw === 'object')` (linha 822) que trataria o Record é
    // inalcançável: `headersRaw` nunca é um Record, sempre array.
    // Resultado: headers vindos como Record somem silenciosamente.
    // Teste fixa o comportamento ATUAL, não o desejado.
    const cfg = tr("respond_to_webhook", { responseHeaders: { "X-A": "={{ $json.v }}" } });

    expect(cfg.headers).toEqual({});
  });
});

describe("tradutores — websocket", () => {
  test("traduz url/operation/message", () => {
    expect(tr("websocket", { url: "wss://x", operation: "send", message: "={{ $json.m }}" })).toMatchObject(
      { url: "wss://x", operation: "send", message: "{{ prev.m }}" },
    );
  });

  test("operation default é send", () => {
    expect(tr("websocket", { url: "wss://x" }).operation).toBe("send");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Tradutores — bancos de dados
// ══════════════════════════════════════════════════════════════════════════

describe("tradutores — postgres / redis", () => {
  test("postgres traduz query e fixa connectionRef convencional", () => {
    // Act
    const cfg = tr("postgres", {
      operation: "executeQuery",
      query: "SELECT * FROM clientes WHERE id = '{{ $json.id }}'",
    });

    // Assert: connectionRef é convenção — o usuário cadastra depois.
    expect(cfg).toMatchObject({
      connectionRef: "default_postgres",
      mode: "sql",
      query: "SELECT * FROM clientes WHERE id = '{{ prev.id }}'",
      params: [],
    });
    expect(cfg).not.toHaveProperty("_n8n_operation");
  });

  test("postgres com operation != executeQuery guarda `_n8n_operation`", () => {
    expect(tr("postgres", { operation: "insert", table: "t" })._n8n_operation).toBe("insert");
  });

  test("postgres sem query devolve string vazia", () => {
    expect(tr("postgres", {}).query).toBe("");
  });

  test("redis mapeia operations do n8n pros comandos internos", () => {
    expect(tr("redis", { operation: "delete", key: "k" }).operation).toBe("del");
    expect(tr("redis", { operation: "push", list: "l", messageData: "m" }).operation).toBe("rpush");
    expect(tr("redis", { operation: "pop", list: "l" }).operation).toBe("lpop");
    expect(tr("redis", { operation: "get", key: "k" }).operation).toBe("get");
  });

  test("redis monta args a partir de key/list/channel + value", () => {
    // Act
    const cfg = tr("redis", { operation: "set", key: "={{ $json.chave }}", value: "={{ $json.v }}" });

    // Assert
    expect(cfg.connectionRef).toBe("default_redis");
    expect(cfg.args).toEqual(["{{ prev.chave }}", "{{ prev.v }}"]);
  });

  test("redis publish usa channel + messageData", () => {
    const cfg = tr("redis", { operation: "publish", channel: "eventos", messageData: "ping" });
    expect(cfg).toMatchObject({ operation: "publish", args: ["eventos", "ping"] });
  });

  test("redis com operation não mapeada mantém o valor cru", () => {
    expect(tr("redis", { operation: "keys" }).operation).toBe("keys");
  });

  test("redis sem operation assume get e args vazios", () => {
    expect(tr("redis", {})).toMatchObject({ operation: "get", args: [] });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Tradutores — código
// ══════════════════════════════════════════════════════════════════════════

describe("tradutores — code / transform", () => {
  test("jsCode vira code com language javascript", () => {
    expect(tr("code", { jsCode: "return items;", language: "javaScript" })).toMatchObject({
      code: "return items;",
      language: "javaScript",
    });
  });

  test("pythonCode infere language python quando `language` ausente", () => {
    expect(tr("code", { pythonCode: "return items" })).toMatchObject({
      code: "return items",
      language: "python",
    });
  });

  test("functionCode legado é aceito", () => {
    expect(tr("code", { functionCode: "return items;" })).toMatchObject({
      code: "return items;",
      language: "javascript",
    });
  });

  test("code sem nenhum campo devolve string vazia e javascript", () => {
    expect(tr("code", {})).toMatchObject({ code: "", language: "javascript" });
  });

  test("BUG CONHECIDO: o código do `code` NÃO passa pelo rewriter de expressões", () => {
    // translateCode (n8n-translators.ts:401) desestrutura só `params` e nunca
    // chama rewriteDeep — `$json`/`$('Node')` dentro do script permanecem crus.
    // (O handler `code` tem polyfills próprios pra $json, então isso é
    // intencional para $json, mas `$('Nome')` não é resolvido pra steps.<id>.)
    const cfg = tr("code", { jsCode: "const x = $('Outro').item.json.a;" }, { Outro: "id-1" });
    expect(cfg.code).toBe("const x = $('Outro').item.json.a;");
  });

  test("transform reescreve expressões dentro de `code`", () => {
    expect(tr("transform", { code: "={{ $json.a }}" }).code).toBe("{{ prev.a }}");
  });

  test("transform aceita jsCode como alternativa", () => {
    expect(tr("transform", { jsCode: "return 1;" }).code).toBe("return 1;");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Tradutores — IA / LangChain
// ══════════════════════════════════════════════════════════════════════════

describe("tradutores — ai_chat / ai_agent", () => {
  test("infere provider anthropic pelo nome do modelo e reescreve o prompt", () => {
    // Arrange: shape do lmChatAnthropic com resource locator no model.
    const params = {
      model: { __rl: true, value: "claude-sonnet-4-5", mode: "list" },
      text: "={{ $json.pergunta }}",
      options: { systemMessage: "Você é um assistente. Cliente: {{ $json.nome }}" },
    };

    // Act
    const cfg = tr("ai_chat", params);

    // Assert
    expect(cfg).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      prompt: "{{ prev.pergunta }}",
      system: "Você é um assistente. Cliente: {{ prev.nome }}",
    });
  });

  test("heurística de provider cobre google/openai/mistral/ollama", () => {
    const p = (model: string) => tr("ai_chat", { model, text: "oi" }).provider;

    expect(p("gemini-2.0-flash")).toBe("google");
    expect(p("gpt-4o-mini")).toBe("openai");
    expect(p("o3-mini")).toBe("openai");
    expect(p("mistral-large-latest")).toBe("mistral");
    expect(p("llama3.1:8b")).toBe("ollama");
    expect(p("sonnet-latest")).toBe("anthropic");
    expect(p("opus-latest")).toBe("anthropic");
  });

  test("modelo desconhecido cai em openai (default da heurística)", () => {
    expect(tr("ai_chat", { model: "modelo-exotico-xyz", text: "oi" }).provider).toBe("openai");
  });

  test("sem model usa o default claude-sonnet-4-6 mas provider openai", () => {
    // Comportamento atual: `modelStr` vazio não casa nenhuma heurística → openai,
    // enquanto `model` cai no default anthropic. Divergência preservada.
    const cfg = tr("ai_chat", { text: "oi" });
    expect(cfg.model).toBe("claude-sonnet-4-6");
    expect(cfg.provider).toBe("openai");
  });

  test("prompt vem de `messages.messageValues[0].content` quando `text` está vazio", () => {
    // Arrange: shape do chainLlm/openAi.
    const params = {
      model: "gpt-4o",
      messages: { messageValues: [{ content: "={{ $json.msg }}" }] },
    };

    // Act / Assert
    expect(tr("ai_chat", params).prompt).toBe("{{ prev.msg }}");
  });

  test("prompt também aceita `prompt` e `input`", () => {
    expect(tr("ai_chat", { prompt: "p" }).prompt).toBe("p");
    expect(tr("ai_chat", { input: "i" }).prompt).toBe("i");
  });

  test("sem systemMessage a chave `system` é omitida", () => {
    expect(tr("ai_chat", { model: "gpt-4o", text: "oi" })).not.toHaveProperty("system");
  });

  test("ai_agent reusa exatamente o tradutor do ai_chat", () => {
    const params = { model: "gpt-4o", text: "={{ $json.q }}" };
    expect(tr("ai_agent", params)).toEqual(tr("ai_chat", params));
  });
});

describe("tradutores — embeddings / vector_store / chat_memory / document_loader", () => {
  test("embeddings extrai model do resource locator", () => {
    expect(tr("embeddings", { model: { __rl: true, value: "text-embedding-3-large" } }).model).toBe(
      "text-embedding-3-large",
    );
  });

  test("embeddings aceita model como string", () => {
    expect(tr("embeddings", { model: "embed-v4" }).model).toBe("embed-v4");
  });

  test("embeddings sem model usa text-embedding-3-small", () => {
    expect(tr("embeddings", {}).model).toBe("text-embedding-3-small");
  });

  test("vector_store mode=insert vira operation insert", () => {
    // Act
    const cfg = tr("vector_store", { mode: "insert", tableName: "documentos" });

    // Assert
    expect(cfg).toMatchObject({
      connectionRef: "default_postgres",
      table: "documentos",
      operation: "insert",
    });
    expect(cfg).not.toHaveProperty("topK");
  });

  test("vector_store mode=load vira search (qualquer coisa != insert)", () => {
    expect(tr("vector_store", { mode: "load" }).operation).toBe("search");
    expect(tr("vector_store", {}).operation).toBe("search");
  });

  test("vector_store search com options.topK propaga topK", () => {
    expect(tr("vector_store", { mode: "load", options: { topK: 8 } }).topK).toBe(8);
  });

  test("vector_store aceita collectionName / indexName como nome da tabela", () => {
    expect(tr("vector_store", { collectionName: "col" }).table).toBe("col");
    expect(tr("vector_store", { indexName: "idx" }).table).toBe("idx");
    expect(tr("vector_store", {}).table).toBe("documents");
  });

  test("chat_memory traduz sessionKey e limite de janela", () => {
    // Act
    const cfg = tr("chat_memory", {
      sessionKey: "={{ $json.sessionId }}",
      tableName: "historico",
      contextWindowLength: 20,
    });

    // Assert
    expect(cfg).toMatchObject({
      connectionRef: "default_postgres",
      table: "historico",
      sessionId: "{{ prev.sessionId }}",
      operation: "load",
      limit: 20,
    });
  });

  test("chat_memory aceita sessionId e aplica defaults", () => {
    expect(tr("chat_memory", { sessionId: "abc" })).toMatchObject({
      table: "chat_messages",
      sessionId: "abc",
    });
  });

  test("chat_memory sem sessão devolve string vazia", () => {
    expect(tr("chat_memory", {}).sessionId).toBe("");
  });

  test("document_loader traduz texto, chunking e metadados", () => {
    // Arrange: shape do documentDefaultDataLoader.
    const params = {
      jsonData: "={{ $json.conteudo }}",
      options: {
        chunkSize: 1000,
        chunkOverlap: 200,
        metadata: { metadataValues: [{ name: "fonte", value: "={{ $json.url }}" }] },
      },
    };

    // Act
    const cfg = tr("document_loader", params);

    // Assert
    expect(cfg).toMatchObject({
      text: "{{ prev.conteudo }}",
      chunkSize: 1000,
      chunkOverlap: 200,
      metadata: { fonte: "{{ prev.url }}" },
    });
  });

  test("document_loader sem options omite chunk/metadata", () => {
    const cfg = tr("document_loader", { textData: "texto" });
    expect(cfg.text).toBe("texto");
    expect(cfg).not.toHaveProperty("chunkSize");
    expect(cfg).not.toHaveProperty("metadata");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Tradutores — utilitários de dados
// ══════════════════════════════════════════════════════════════════════════

describe("tradutores — date_time", () => {
  test("format monta value + format", () => {
    expect(tr("date_time", { action: "formatDate", value: "={{ $json.criadoEm }}", format: "DD/MM/YYYY" })).toEqual(
      {
        operation: "format",
        value: "{{ prev.criadoEm }}",
        format: "DD/MM/YYYY",
        _n8n: { action: "formatDate", value: "={{ $json.criadoEm }}", format: "DD/MM/YYYY" },
      },
    );
  });

  test("format sem `format` usa o padrão YYYY-MM-DD HH:mm:ss", () => {
    expect(tr("date_time", { action: "format", value: "x" }).format).toBe("YYYY-MM-DD HH:mm:ss");
  });

  test("add mantém amount positivo", () => {
    expect(tr("date_time", { action: "add", value: "x", amount: 3, unit: "days" })).toMatchObject({
      operation: "add",
      amount: 3,
      unit: "days",
    });
  });

  test("subtract vira `add` com amount NEGATIVO", () => {
    expect(tr("date_time", { action: "subtract", value: "x", amount: 3, unit: "days" })).toMatchObject(
      { operation: "add", amount: -3, unit: "days" },
    );
  });

  test("diff mapeia from/to (e aceita startDate/endDate)", () => {
    expect(tr("date_time", { action: "diff", from: "a", to: "b" })).toMatchObject({
      operation: "diff",
      from: "a",
      to: "b",
    });
    expect(tr("date_time", { action: "getTimeBetweenDates", startDate: "a", endDate: "b" })).toMatchObject(
      { operation: "diff", from: "a", to: "b" },
    );
  });

  test("parse só carrega value", () => {
    expect(tr("date_time", { action: "parse", value: "2026-07-16" })).toMatchObject({
      operation: "parse",
      value: "2026-07-16",
    });
  });

  test("sem action assume `now` (config mínima)", () => {
    expect(tr("date_time", {})).toEqual({ operation: "now", _n8n: {} });
  });

  test("action desconhecida é repassada crua como operation", () => {
    expect(tr("date_time", { action: "extractDate" }).operation).toBe("extractDate");
  });
});

describe("tradutores — crypto", () => {
  test("hash traduz algoritmo/valor/encoding em minúsculas", () => {
    // Act
    const cfg = tr("crypto", { action: "hash", type: "SHA256", value: "={{ $json.senha }}", encoding: "HEX" });

    // Assert
    expect(cfg).toMatchObject({
      operation: "hash",
      algorithm: "sha256",
      value: "{{ prev.senha }}",
      encoding: "hex",
    });
  });

  test("hash é o default quando não há action", () => {
    expect(tr("crypto", { value: "x" })).toMatchObject({
      operation: "hash",
      algorithm: "sha256",
      encoding: "hex",
    });
  });

  test("hmac carrega secret", () => {
    expect(tr("crypto", { action: "hmac", type: "sha512", value: "v", secret: "={{ $json.s }}" })).toMatchObject(
      { operation: "hmac", algorithm: "sha512", secret: "{{ prev.s }}" },
    );
  });

  test("generate type=uuid vira operation uuid", () => {
    expect(tr("crypto", { action: "generate", type: "uuid" })).toMatchObject({ operation: "uuid" });
  });

  test("generate de outro tipo vira operation random", () => {
    expect(tr("crypto", { action: "generate", type: "ascii" })).toMatchObject({ operation: "random" });
  });
});

describe("tradutores — item_lists / aggregate", () => {
  test("limit vira slice com `end`", () => {
    expect(tr("item_lists", { operation: "limit", maxItems: 5 })).toMatchObject({
      operation: "slice",
      end: 5,
    });
  });

  test("limit sem maxItems usa 10", () => {
    expect(tr("item_lists", { operation: "limit" }).end).toBe(10);
  });

  test("sort mapeia field e order descending → desc", () => {
    expect(tr("item_lists", { operation: "sort", fieldName: "preco", order: "descending" })).toMatchObject(
      { operation: "sort", field: "preco", order: "desc" },
    );
  });

  test("sortItems (alias legado) também vira sort com order asc default", () => {
    expect(tr("item_lists", { operation: "sortItems", fieldName: "nome" })).toMatchObject({
      operation: "sort",
      order: "asc",
    });
  });

  test("removeDuplicates vira distinct", () => {
    expect(tr("item_lists", { operation: "removeDuplicates", fieldName: "id" })).toMatchObject({
      operation: "distinct",
      field: "id",
    });
  });

  test("operation não mapeada é repassada crua com `_n8n`", () => {
    const cfg = tr("item_lists", { operation: "concatenateItems" });
    expect(cfg.operation).toBe("concatenateItems");
    expect(cfg._n8n).toEqual({ operation: "concatenateItems" });
  });

  test("sem operation assume filter", () => {
    expect(tr("item_lists", {}).operation).toBe("filter");
  });

  test("aggregate com fieldsToAggregate vira sum do 1º campo", () => {
    // Arrange: shape real do aggregate.
    const params = { fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: "valor" }] } };

    // Act / Assert
    expect(tr("aggregate", params)).toMatchObject({ operation: "sum", field: "valor" });
  });

  test("aggregate sem campos vira count", () => {
    expect(tr("aggregate", {})).toMatchObject({ operation: "count", items: [] });
  });
});

describe("tradutores — sort / limit / remove_duplicates / rename_keys / compare_datasets", () => {
  test("sort lê sortFieldsUi.sortField[0]", () => {
    // Arrange: shape real do n8n-nodes-base.sort.
    const params = { sortFieldsUi: { sortField: [{ fieldName: "criadoEm", order: "descending" }] } };

    // Act / Assert
    expect(tr("sort", params)).toMatchObject({ field: "criadoEm", order: "desc" });
  });

  test("sort aceita `sortFields` como array direto e order asc default", () => {
    expect(tr("sort", { sortFields: [{ fieldName: "nome" }] })).toMatchObject({
      field: "nome",
      order: "asc",
    });
  });

  test("sort sem campos devolve field undefined e order asc", () => {
    const cfg = tr("sort", {});
    expect(cfg.field).toBeUndefined();
    expect(cfg.order).toBe("asc");
  });

  test("limit traduz maxItems e keep", () => {
    expect(tr("limit", { maxItems: 3, keep: "lastItems" })).toMatchObject({
      limit: 3,
      keepBehavior: "lastItems",
    });
  });

  test("limit sem params usa 10 / firstItems", () => {
    expect(tr("limit", {})).toMatchObject({ limit: 10, keepBehavior: "firstItems" });
  });

  test("remove_duplicates lista os campos a comparar", () => {
    // Arrange
    const params = {
      compare: "selectedFields",
      fieldsToCompare: { fields: [{ fieldName: "email" }, { fieldName: "cpf" }] },
    };

    // Act / Assert
    expect(tr("remove_duplicates", params)).toMatchObject({
      compare: "selectedFields",
      fields: ["email", "cpf"],
    });
  });

  test("remove_duplicates sem params compara allFields", () => {
    expect(tr("remove_duplicates", {})).toMatchObject({ compare: "allFields", fields: [] });
  });

  test("rename_keys monta o mapping currentKey→newKey", () => {
    // Arrange: shape real do renameKeys.
    const params = {
      keys: {
        key: [
          { currentKey: "nome_completo", newKey: "nome" },
          { currentKey: "e_mail", newKey: "email" },
          { currentKey: "sem par" },
        ],
      },
    };

    // Act / Assert: entradas incompletas são ignoradas.
    expect(tr("rename_keys", params).mapping).toEqual({ nome_completo: "nome", e_mail: "email" });
  });

  test("rename_keys sem keys devolve mapping vazio", () => {
    expect(tr("rename_keys", {})).toMatchObject({ mapping: {}, items: [] });
  });

  test("compare_datasets traduz inputs e mergeMode", () => {
    expect(tr("compare_datasets", { resolve: "preferInput2" })).toMatchObject({
      inputA: [],
      inputB: [],
      mergeMode: "preferInput2",
    });
  });

  test("compare_datasets sem resolve usa preferInput1", () => {
    expect(tr("compare_datasets", {}).mergeMode).toBe("preferInput1");
  });

  test("shuffle só carrega items reescritos", () => {
    expect(tr("shuffle", { items: ["={{ $json.a }}"] })).toMatchObject({ items: ["{{ prev.a }}"] });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Tradutores — comunicação
// ══════════════════════════════════════════════════════════════════════════

describe("tradutores — comunicação", () => {
  test("email_send traduz to/from/subject/body", () => {
    // Arrange: shape real do emailSend.
    const params = {
      toEmail: "={{ $json.cliente.email }}",
      fromEmail: "no-reply@adila.co",
      subject: "=Pedido {{ $json.pedidoId }}",
      text: "={{ $json.corpo }}",
    };

    // Act
    const cfg = tr("email_send", params);

    // Assert
    expect(cfg).toMatchObject({
      to: "{{ prev.cliente.email }}",
      from: "no-reply@adila.co",
      subject: "Pedido {{ prev.pedidoId }}",
      body: "{{ prev.corpo }}",
    });
    expect(cfg.html).toBeUndefined();
  });

  test("email_send com html preenche body e html", () => {
    const cfg = tr("email_send", { to: "a@b.c", html: "<p>={{ $json.x }}</p>" });
    expect(cfg.html).toBe("<p>={{ prev.x }}</p>");
    // `body` cai no html porque `text` está ausente.
    expect(cfg.body).toBe("<p>={{ prev.x }}</p>");
  });

  test("email_send sem nada devolve strings vazias", () => {
    expect(tr("email_send", {})).toMatchObject({ to: "", from: "", subject: "", body: "" });
  });

  test("slack_webhook traduz resource/channel/text", () => {
    expect(tr("slack_webhook", { resource: "message", channel: "#geral", text: "={{ $json.msg }}" })).toMatchObject(
      { resource: "message", channel: "#geral", text: "{{ prev.msg }}" },
    );
  });

  test("slack_webhook aceita channelId e `message`, com resource default", () => {
    expect(tr("slack_webhook", { channelId: "C123", message: "oi" })).toMatchObject({
      resource: "message",
      channel: "C123",
      text: "oi",
    });
  });

  test("discord_webhook traduz webhookUri → webhookUrl", () => {
    expect(tr("discord_webhook", { webhookUri: "https://discord/x", text: "={{ $json.t }}" })).toMatchObject(
      { webhookUrl: "https://discord/x", content: "{{ prev.t }}" },
    );
  });

  test("discord_webhook aceita webhookUrl/content diretos", () => {
    expect(tr("discord_webhook", { webhookUrl: "u", content: "c" })).toMatchObject({
      webhookUrl: "u",
      content: "c",
    });
  });

  test("telegram_send traduz chatId/text com parseMode default Markdown", () => {
    expect(tr("telegram_send", { chatId: "={{ $json.chat }}", text: "oi" })).toMatchObject({
      chatId: "{{ prev.chat }}",
      text: "oi",
      parseMode: "Markdown",
    });
  });

  test("telegram_send respeita parseMode explícito", () => {
    expect(tr("telegram_send", { chatId: "1", parseMode: "HTML" }).parseMode).toBe("HTML");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Tradutores — parsers / formatos / arquivos
// ══════════════════════════════════════════════════════════════════════════

describe("tradutores — parsers e formatos", () => {
  test("html_extract monta as queries de css selector", () => {
    // Arrange: shape real do node html (extractHtmlContent).
    const params = {
      dataPropertyName: "={{ $json.pagina }}",
      extractionValues: {
        values: [
          { key: "titulo", cssSelector: "h1", returnValue: "text" },
          { key: "link", cssSelector: "a", returnValue: "attribute" },
          { key: "invalido" },
        ],
      },
    };

    // Act
    const cfg = tr("html_extract", params);

    // Assert: entrada sem cssSelector é descartada.
    expect(cfg.html).toBe("{{ prev.pagina }}");
    expect(cfg.queries).toEqual([
      { key: "titulo", cssSelector: "h1", returnValue: "text" },
      { key: "link", cssSelector: "a", returnValue: "attribute" },
    ]);
  });

  test("html_extract sem extractionValues devolve queries vazio", () => {
    expect(tr("html_extract", { html: "<p/>" })).toMatchObject({ html: "<p/>", queries: [] });
  });

  test("markdown traduz mode e input", () => {
    expect(tr("markdown", { mode: "htmlToMarkdown", html: "={{ $json.h }}" })).toMatchObject({
      mode: "htmlToMarkdown",
      input: "{{ prev.h }}",
    });
  });

  test("markdown default é markdownToHtml", () => {
    expect(tr("markdown", { markdown: "# oi" })).toMatchObject({
      mode: "markdownToHtml",
      input: "# oi",
    });
  });

  test("xml default é xmlToJson", () => {
    expect(tr("xml", { xml: "<a/>" })).toMatchObject({ mode: "xmlToJson", input: "<a/>" });
    expect(tr("xml", { mode: "jsonToxml", dataPropertyName: "data" })).toMatchObject({
      mode: "jsonToxml",
      input: "data",
    });
  });

  test("yaml default é yamlToJson", () => {
    expect(tr("yaml", { yaml: "a: 1" })).toMatchObject({ mode: "yamlToJson", input: "a: 1" });
  });

  test("json default é stringify", () => {
    expect(tr("json", { json: "={{ $json.obj }}" })).toMatchObject({
      mode: "stringify",
      input: "{{ prev.obj }}",
    });
    expect(tr("json", { mode: "parse", string: "{}" })).toMatchObject({ mode: "parse", input: "{}" });
  });

  test("csv default é fromFile", () => {
    expect(tr("csv", { binaryPropertyName: "data" })).toMatchObject({
      operation: "fromFile",
      data: "data",
    });
    expect(tr("csv", { operation: "toFile", dataPropertyName: "d" })).toMatchObject({
      operation: "toFile",
      data: "d",
    });
  });

  test("pdf_extract aplica defaults de binaryProperty/operation", () => {
    expect(tr("pdf_extract", {})).toMatchObject({
      binaryProperty: "data",
      operation: "pdf",
      source: "",
    });
  });

  test("pdf_extract traduz binaryPropertyName e url", () => {
    expect(tr("pdf_extract", { binaryPropertyName: "arquivo", url: "={{ $json.url }}" })).toMatchObject(
      { binaryProperty: "arquivo", source: "{{ prev.url }}" },
    );
  });

  test("template traduz template e data", () => {
    expect(tr("template", { template: "Olá ={{ $json.nome }}", data: { a: "={{ $json.a }}" } })).toMatchObject(
      { template: "Olá ={{ prev.nome }}", data: { a: "{{ prev.a }}" } },
    );
  });

  test("template sem params devolve vazios", () => {
    expect(tr("template", {})).toMatchObject({ template: "", data: {} });
  });

  test("text_manipulation default é concat", () => {
    expect(tr("text_manipulation", { text: "={{ $json.t }}" })).toMatchObject({
      operation: "concat",
      input: "{{ prev.t }}",
    });
    expect(tr("text_manipulation", { operation: "upperCase", input: "x" })).toMatchObject({
      operation: "upperCase",
      input: "x",
    });
  });
});

describe("tradutores — arquivos / cloud", () => {
  test("s3 traduz bucket/key/region", () => {
    // Act
    const cfg = tr("s3", {
      operation: "download",
      bucketName: "meu-bucket",
      fileKey: "={{ $json.caminho }}",
      region: "sa-east-1",
    });

    // Assert
    expect(cfg).toMatchObject({
      operation: "download",
      bucket: "meu-bucket",
      key: "{{ prev.caminho }}",
      region: "sa-east-1",
    });
  });

  test("s3 aceita bucket/key diretos e aplica defaults", () => {
    expect(tr("s3", { bucket: "b", key: "k" })).toMatchObject({
      operation: "upload",
      bucket: "b",
      key: "k",
      region: "us-east-1",
    });
  });

  test("compression aplica defaults compress/zip/data", () => {
    expect(tr("compression", {})).toMatchObject({
      operation: "compress",
      format: "zip",
      binaryProperty: "data",
      source: "",
    });
  });

  test("compression traduz outputFormat e fileName", () => {
    expect(
      tr("compression", { operation: "decompress", outputFormat: "gzip", fileName: "={{ $json.f }}" }),
    ).toMatchObject({ operation: "decompress", format: "gzip", source: "{{ prev.f }}" });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Tradutores — utilitários simples
// ══════════════════════════════════════════════════════════════════════════

describe("tradutores — utilitários simples", () => {
  test("jwt traduz token/secret/payload com defaults", () => {
    expect(tr("jwt", { token: "={{ $json.token }}", secret: "={{ $env.JWT_SECRET }}" })).toMatchObject(
      { operation: "verify", token: "{{ prev.token }}", secret: "{{ env.JWT_SECRET }}", payload: {} },
    );
  });

  test("jwt operation=sign é preservada", () => {
    expect(tr("jwt", { operation: "sign", payload: { sub: "1" } })).toMatchObject({
      operation: "sign",
      payload: { sub: "1" },
    });
  });

  test("url_tools default é parse", () => {
    expect(tr("url_tools", { url: "={{ $json.link }}" })).toMatchObject({
      operation: "parse",
      url: "{{ prev.link }}",
    });
  });

  test("uuid ignora os parameters (config vazia + `_n8n`)", () => {
    expect(tr("uuid", { qualquer: 1 })).toEqual({ _n8n: { qualquer: 1 } });
  });

  test("random traduz min/max e integer default true", () => {
    expect(tr("random", { min: 1, max: 6 })).toMatchObject({ min: 1, max: 6, integer: true });
  });

  test("random com integer:false preserva o flag", () => {
    expect(tr("random", { integer: false }).integer).toBe(false);
  });

  test("random sem params usa 0..100", () => {
    expect(tr("random", {})).toMatchObject({ min: 0, max: 100, integer: true });
  });

  test("math reescreve a expressão", () => {
    expect(tr("math", { expression: "={{ $json.a }} + 1" })).toMatchObject({
      expression: "{{ prev.a }} + 1",
    });
  });

  test("math aceita `formula` como alternativa", () => {
    expect(tr("math", { formula: "2+2" }).expression).toBe("2+2");
  });

  test("container extrai o label", () => {
    expect(tr("container", { label: "Grupo A" })).toMatchObject({ label: "Grupo A" });
    expect(tr("container", {}).label).toBe("");
  });

  test("sticky_note traduz content/width/height/color", () => {
    // Act
    const cfg = tr("sticky_note", { content: "## Nota", width: 300, height: 160, color: 4 });

    // Assert
    expect(cfg).toMatchObject({ content: "## Nota", width: 300, height: 160, color: 4 });
  });

  test("sticky_note sem dimensões omite width/height/color", () => {
    const cfg = tr("sticky_note", { content: "x" });
    expect(cfg).not.toHaveProperty("width");
    expect(cfg).not.toHaveProperty("height");
    expect(cfg).not.toHaveProperty("color");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// importN8nWorkflow — validação de payload
// ══════════════════════════════════════════════════════════════════════════

/**
 * Roda o import e estreita a união pro caso de sucesso — os testes de erro
 * chamam `importN8nWorkflow` direto.
 */
function imported(raw: unknown): ImportResult {
  const res = importN8nWorkflow(raw);
  if ("error" in res) throw new Error(`import falhou inesperadamente: ${res.error}`);
  return res;
}

/** Constrói um workflow n8n mínimo válido. */
function wf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "Meu Workflow", nodes: [], connections: {}, ...overrides };
}

describe("importN8nWorkflow — validação de payload", () => {
  test("payload não-objeto devolve invalid_payload", () => {
    expect(importN8nWorkflow(null)).toEqual({ error: "invalid_payload" });
    expect(importN8nWorkflow("string")).toEqual({ error: "invalid_payload" });
    expect(importN8nWorkflow(42)).toEqual({ error: "invalid_payload" });
    expect(importN8nWorkflow(undefined)).toEqual({ error: "invalid_payload" });
  });

  test("payload sem `nodes` array devolve invalid_n8n_workflow", () => {
    expect(importN8nWorkflow({ name: "x" })).toEqual({ error: "invalid_n8n_workflow" });
    expect(importN8nWorkflow({ nodes: "nao-array" })).toEqual({ error: "invalid_n8n_workflow" });
  });

  test("workflow sem `name` ganha nome default (não é rejeitado)", () => {
    // Act
    const res = importN8nWorkflow({ nodes: [] });

    // Assert
    expect(res).not.toHaveProperty("error");
    expect((res as { name: string }).name).toBe("Workflow importado do n8n");
  });

  test("`name` só com espaços também cai no default", () => {
    expect((imported({ name: "   ", nodes: [] })).name).toBe(
      "Workflow importado do n8n",
    );
  });

  test("envelope `{ workflows: [...] }` usa o primeiro workflow", () => {
    // Arrange: export multi-workflow do n8n.
    const payload = { workflows: [wf({ name: "Primeiro" }), wf({ name: "Segundo" })] };

    // Act
    const res = imported(payload);

    // Assert
    expect(res.name).toBe("Primeiro");
  });

  test("workflow vazio produz definition vazia com summary zerado", () => {
    // Act
    const res = imported(wf());

    // Assert
    expect(res.definition.nodes).toEqual([]);
    expect(res.definition.edges).toEqual([]);
    expect(res.summary).toMatchObject({ total: 0, mapped: 0, unsupported: 0, skipped: 0 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// importN8nWorkflow — mapeamento de nós
// ══════════════════════════════════════════════════════════════════════════

describe("importN8nWorkflow — mapeamento de nós", () => {
  test("nó mapeado vira o tipo interno com config traduzida + metadados", () => {
    // Arrange: httpRequest realista.
    const payload = wf({
      nodes: [
        {
          id: "uuid-http",
          name: "Buscar Cliente",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          position: [100, 200],
          parameters: { url: "={{ $json.base }}/c", method: "GET" },
          notes: "chama a API",
        },
      ],
    });

    // Act
    const res = imported(payload);
    const node = res.definition.nodes[0];

    // Assert
    expect(node.id).toBe("uuid-http");
    expect(node.type).toBe("http_request");
    expect(node.config.url).toBe("{{ prev.base }}/c");
    expect(node.config.n8nName).toBe("Buscar Cliente");
    expect(node.config.originalType).toBe("n8n-nodes-base.httpRequest");
    expect(node.config._runtime).toEqual({ n8nTypeVersion: 4.2 });
    expect(node.config._editor).toEqual({
      position: { x: 0, y: 0 },
      title: "Buscar Cliente",
      notes: "chama a API",
    });
    expect(res.summary.mapped).toBe(1);
  });

  test("tipo sem mapeamento vira `noop` marcado como _unsupported", () => {
    // Arrange
    const payload = wf({
      nodes: [
        {
          id: "n1",
          name: "Notion",
          type: "n8n-nodes-base.notion",
          position: [0, 0],
          parameters: { resource: "page" },
        },
      ],
    });

    // Act
    const res = imported(payload);

    // Assert
    expect(res.definition.nodes[0].type).toBe("noop");
    expect(res.definition.nodes[0].config._unsupported).toBe(true);
    expect(res.definition.nodes[0].config.parameters).toEqual({ resource: "page" });
    expect(res.definition.nodes[0].config.originalType).toBe("n8n-nodes-base.notion");
    expect(res.summary).toMatchObject({ unsupported: 1, mapped: 0 });
    expect(res.summary.unsupportedTypes).toEqual(["n8n-nodes-base.notion"]);
  });

  test("unsupportedTypes é deduplicado e ordenado", () => {
    // Arrange: dois nós do mesmo tipo + um de outro tipo, fora de ordem.
    const payload = wf({
      nodes: [
        { id: "1", name: "Z", type: "n8n-nodes-base.zulip", parameters: {} },
        { id: "2", name: "A1", type: "n8n-nodes-base.airtable", parameters: {} },
        { id: "3", name: "A2", type: "n8n-nodes-base.airtable", parameters: {} },
      ],
    });

    // Act
    const res = imported(payload);

    // Assert
    expect(res.summary.unsupportedTypes).toEqual([
      "n8n-nodes-base.airtable",
      "n8n-nodes-base.zulip",
    ]);
  });

  test("nós malformados (sem id ou type) são pulados sem crashar", () => {
    // Arrange
    const payload = wf({
      nodes: [
        { name: "sem id", type: "n8n-nodes-base.noOp", parameters: {} },
        { id: "sem-type", name: "x", parameters: {} },
        null,
        { id: "ok", name: "Ok", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
    });

    // Act
    const res = imported(payload);

    // Assert: `total` conta o array cru, mas só o nó válido entra.
    expect(res.summary.total).toBe(4);
    expect(res.definition.nodes).toHaveLength(1);
    expect(res.definition.nodes[0].id).toBe("ok");
    expect(res.summary.mapped).toBe(1);
  });

  test("nó `disabled` carrega a flag na config", () => {
    const payload = wf({
      nodes: [{ id: "n", name: "N", type: "n8n-nodes-base.noOp", disabled: true, parameters: {} }],
    });
    const res = imported(payload);
    expect(res.definition.nodes[0].config.disabled).toBe(true);
  });

  test("metadados de runtime do n8n são preservados em `_runtime`", () => {
    // Arrange
    const payload = wf({
      nodes: [
        {
          id: "n",
          name: "N",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4,
          retryOnFail: true,
          maxTries: 5,
          waitBetweenTries: 2000,
          continueOnFail: true,
          alwaysOutputData: true,
          executeOnce: true,
          webhookId: "wh-abc",
          credentials: { httpBasicAuth: { id: "1", name: "cred" } },
          parameters: { url: "u" },
        },
      ],
    });

    // Act
    const res = imported(payload);

    // Assert
    expect(res.definition.nodes[0].config._runtime).toEqual({
      retryOnFail: true,
      maxTries: 5,
      waitBetweenTries: 2000,
      continueOnFail: true,
      alwaysOutputData: true,
      executeOnce: true,
      n8nTypeVersion: 4,
      n8nWebhookId: "wh-abc",
      n8nCredentials: { httpBasicAuth: { id: "1", name: "cred" } },
    });
  });

  test("nó sem metadados de runtime omite `_runtime`", () => {
    const payload = wf({
      nodes: [{ id: "n", name: "N", type: "n8n-nodes-base.noOp", parameters: {} }],
    });
    const res = imported(payload);
    expect(res.definition.nodes[0].config).not.toHaveProperty("_runtime");
  });

  test("aliases de tipo mapeiam pro mesmo tipo interno (cron/function/gmail)", () => {
    // Arrange
    const payload = wf({
      nodes: [
        { id: "1", name: "Cron", type: "n8n-nodes-base.cron", parameters: {} },
        { id: "2", name: "Fn", type: "n8n-nodes-base.function", parameters: {} },
        { id: "3", name: "Gmail", type: "n8n-nodes-base.gmail", parameters: {} },
        { id: "4", name: "Chat", type: "@n8n/n8n-nodes-langchain.chatTrigger", parameters: {} },
      ],
    });

    // Act
    const res = imported(payload);

    // Assert
    expect(res.definition.nodes.map((n) => n.type)).toEqual([
      "schedule_trigger",
      "code",
      "email_send",
      "start",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// importN8nWorkflow — sticky note (tratamento especial)
// ══════════════════════════════════════════════════════════════════════════

describe("importN8nWorkflow — sticky note", () => {
  test("content vira `text` e width/height/color vão pro `_editor`", () => {
    // Arrange: stickyNote com color 4 (azul na tabela do importer).
    const payload = wf({
      nodes: [
        {
          id: "s1",
          name: "Nota",
          type: "n8n-nodes-base.stickyNote",
          position: [0, 0],
          parameters: { content: "## Atenção", width: 320, height: 180, color: 4 },
        },
      ],
    });

    // Act
    const res = imported(payload);
    const cfg = res.definition.nodes[0].config;

    // Assert
    expect(res.definition.nodes[0].type).toBe("sticky_note");
    expect(cfg.text).toBe("## Atenção");
    expect(cfg.color).toBe("blue");
    expect(cfg).not.toHaveProperty("content");
    expect(cfg._editor).toMatchObject({ width: 320, height: 180, title: "Nota" });
  });

  test("mapeia toda a paleta numérica de cores do n8n", () => {
    // Arrange: 1..7 → nomes; 99 (fora da tabela) → yellow.
    const cores = [1, 2, 3, 4, 5, 6, 7, 99];
    const payload = wf({
      nodes: cores.map((color, i) => ({
        id: `s${i}`,
        name: `N${i}`,
        type: "n8n-nodes-base.stickyNote",
        parameters: { content: "x", color },
      })),
    });

    // Act
    const res = imported(payload);

    // Assert
    expect(res.definition.nodes.map((n) => n.config.color)).toEqual([
      "yellow",
      "orange",
      "red",
      "blue",
      "cyan",
      "green",
      "purple",
      "yellow",
    ]);
  });

  test("sticky sem color omite a chave color", () => {
    const payload = wf({
      nodes: [
        { id: "s", name: "N", type: "n8n-nodes-base.stickyNote", parameters: { content: "x" } },
      ],
    });
    const res = imported(payload);
    expect(res.definition.nodes[0].config).not.toHaveProperty("color");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// importN8nWorkflow — edges
// ══════════════════════════════════════════════════════════════════════════

describe("importN8nWorkflow — edges", () => {
  test("conexão linear vira edge sem label", () => {
    // Arrange
    const payload = wf({
      nodes: [
        { id: "a", name: "A", type: "n8n-nodes-base.manualTrigger", parameters: {} },
        { id: "b", name: "B", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: { A: { main: [[{ node: "B", type: "main", index: 0 }]] } },
    });

    // Act
    const res = imported(payload);

    // Assert: nomes do n8n resolvidos pros ids.
    expect(res.definition.edges).toEqual([{ from: "a", to: "b", label: undefined }]);
  });

  test("if produz labels `true` (idx 0) e `false` (idx 1)", () => {
    // Arrange
    const payload = wf({
      nodes: [
        { id: "i", name: "Se", type: "n8n-nodes-base.if", parameters: {} },
        { id: "t", name: "Sim", type: "n8n-nodes-base.noOp", parameters: {} },
        { id: "f", name: "Nao", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: { Se: { main: [[{ node: "Sim" }], [{ node: "Nao" }]] } },
    });

    // Act
    const res = imported(payload);

    // Assert
    expect(res.definition.edges).toEqual([
      { from: "i", to: "t", label: "true" },
      { from: "i", to: "f", label: "false" },
    ]);
  });

  test("filter também usa labels true/false", () => {
    const payload = wf({
      nodes: [
        { id: "f", name: "Filtro", type: "n8n-nodes-base.filter", parameters: {} },
        { id: "n", name: "Next", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: { Filtro: { main: [[{ node: "Next" }]] } },
    });
    const res = imported(payload);
    expect(res.definition.edges[0].label).toBe("true");
  });

  test("switch numera os ramos e nomeia o fallback `extra` como `default`", () => {
    // Arrange: switch com 2 regras + fallbackOutput extra (3º ramo).
    const payload = wf({
      nodes: [
        {
          id: "sw",
          name: "Rota",
          type: "n8n-nodes-base.switch",
          parameters: {
            rules: { values: [{ outputKey: "a" }, { outputKey: "b" }] },
            options: { fallbackOutput: "extra" },
          },
        },
        { id: "x", name: "X", type: "n8n-nodes-base.noOp", parameters: {} },
        { id: "y", name: "Y", type: "n8n-nodes-base.noOp", parameters: {} },
        { id: "z", name: "Z", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: { Rota: { main: [[{ node: "X" }], [{ node: "Y" }], [{ node: "Z" }]] } },
    });

    // Act
    const res = imported(payload);

    // Assert: idx 2 == rules.length → vira "default".
    expect(res.definition.edges).toEqual([
      { from: "sw", to: "x", label: "0" },
      { from: "sw", to: "y", label: "1" },
      { from: "sw", to: "z", label: "default" },
    ] as unknown as Array<{ to: string; label?: string }>);
  });

  test("switch SEM fallbackOutput extra numera todos os ramos", () => {
    const payload = wf({
      nodes: [
        {
          id: "sw",
          name: "Rota",
          type: "n8n-nodes-base.switch",
          parameters: { rules: { values: [{}, {}] } },
        },
        { id: "x", name: "X", type: "n8n-nodes-base.noOp", parameters: {} },
        { id: "y", name: "Y", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: { Rota: { main: [[{ node: "X" }], [{ node: "Y" }]] } },
    });
    const res = imported(payload);
    expect(res.definition.edges.map((e) => e.label)).toEqual(["0", "1"]);
  });

  test("outputKind != main vira o label da edge (portas LangChain)", () => {
    // Arrange: um lmChat ligado num agent pela porta `ai_languageModel`.
    const payload = wf({
      nodes: [
        { id: "m", name: "Modelo", type: "@n8n/n8n-nodes-langchain.lmChatOpenAi", parameters: {} },
        { id: "a", name: "Agente", type: "@n8n/n8n-nodes-langchain.agent", parameters: {} },
      ],
      connections: { Modelo: { ai_languageModel: [[{ node: "Agente", type: "ai_languageModel" }]] } },
    });

    // Act
    const res = imported(payload);

    // Assert
    expect(res.definition.edges[0].label).toBe("ai_languageModel");
  });

  test("um nó com múltiplos alvos no mesmo ramo gera uma edge por alvo", () => {
    const payload = wf({
      nodes: [
        { id: "a", name: "A", type: "n8n-nodes-base.noOp", parameters: {} },
        { id: "b", name: "B", type: "n8n-nodes-base.noOp", parameters: {} },
        { id: "c", name: "C", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: { A: { main: [[{ node: "B" }, { node: "C" }]] } },
    });
    const res = imported(payload);
    expect(res.definition.edges).toHaveLength(2);
    expect(res.definition.edges.map((e) => e.to)).toEqual(["b", "c"]);
  });

  test("conexões pra nós inexistentes são descartadas", () => {
    const payload = wf({
      nodes: [{ id: "a", name: "A", type: "n8n-nodes-base.noOp", parameters: {} }],
      connections: {
        A: { main: [[{ node: "Fantasma" }]] },
        Inexistente: { main: [[{ node: "A" }]] },
      },
    });
    const res = imported(payload);
    expect(res.definition.edges).toEqual([]);
  });

  test("ramos null (saída sem conexão) são ignorados", () => {
    // Arrange: n8n emite `null` para saídas desconectadas.
    const payload = wf({
      nodes: [
        { id: "i", name: "Se", type: "n8n-nodes-base.if", parameters: {} },
        { id: "t", name: "Sim", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: { Se: { main: [[{ node: "Sim" }], null] } },
    });

    // Act
    const res = imported(payload);

    // Assert
    expect(res.definition.edges).toHaveLength(1);
  });

  test("workflow sem `connections` não gera edges", () => {
    const payload = { name: "x", nodes: [{ id: "a", name: "A", type: "n8n-nodes-base.noOp" }] };
    const res = imported(payload);
    expect(res.definition.edges).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// importN8nWorkflow — posições, pinData, settings, tags
// ══════════════════════════════════════════════════════════════════════════

describe("importN8nWorkflow — normalização de posições", () => {
  test("posições absolutas distantes são transladadas pra perto de (0,0)", () => {
    // Arrange: coordenadas típicas de um canvas n8n antigo.
    const payload = wf({
      nodes: [
        { id: "a", name: "A", type: "n8n-nodes-base.noOp", position: [6624, 2944], parameters: {} },
        { id: "b", name: "B", type: "n8n-nodes-base.noOp", position: [6824, 3144], parameters: {} },
      ],
    });

    // Act
    const res = imported(payload);

    // Assert: layout relativo preservado, origem normalizada.
    expect(res.definition.nodes[0].config._editor.position).toEqual({ x: 0, y: 0 });
    expect(res.definition.nodes[1].config._editor.position).toEqual({ x: 200, y: 200 });
  });

  test("offsets X e Y são calculados independentemente (mínimo de cada eixo)", () => {
    const payload = wf({
      nodes: [
        { id: "a", name: "A", type: "n8n-nodes-base.noOp", position: [100, 900], parameters: {} },
        { id: "b", name: "B", type: "n8n-nodes-base.noOp", position: [500, 300], parameters: {} },
      ],
    });
    const res = imported(payload);
    // offsetX=100, offsetY=300.
    expect(res.definition.nodes[0].config._editor.position).toEqual({ x: 0, y: 600 });
    expect(res.definition.nodes[1].config._editor.position).toEqual({ x: 400, y: 0 });
  });

  test("posições negativas também são normalizadas", () => {
    const payload = wf({
      nodes: [
        { id: "a", name: "A", type: "n8n-nodes-base.noOp", position: [-500, -200], parameters: {} },
        { id: "b", name: "B", type: "n8n-nodes-base.noOp", position: [-300, -200], parameters: {} },
      ],
    });
    const res = imported(payload);
    expect(res.definition.nodes[0].config._editor.position).toEqual({ x: 0, y: 0 });
    expect(res.definition.nodes[1].config._editor.position).toEqual({ x: 200, y: 0 });
  });

  test("nó sem `position` cai em (0,0)", () => {
    const payload = wf({
      nodes: [{ id: "a", name: "A", type: "n8n-nodes-base.noOp", parameters: {} }],
    });
    const res = imported(payload);
    expect(res.definition.nodes[0].config._editor.position).toEqual({ x: 0, y: 0 });
  });
});

describe("importN8nWorkflow — pinData / staticData / settings / tags", () => {
  test("pinData é remapeado de nome (n8n) pra id (engine)", () => {
    // Arrange
    const payload = wf({
      nodes: [{ id: "uuid-a", name: "Webhook", type: "n8n-nodes-base.webhook", parameters: {} }],
      pinData: { Webhook: [{ json: { body: { teste: 1 } } }], NoExiste: [{ json: {} }] },
    });

    // Act
    const res = imported(payload);

    // Assert: só o nó existente é remapeado; a chave vira o id.
    expect(res.definition.pinData).toEqual({ "uuid-a": [{ json: { body: { teste: 1 } } }] });
    expect(res.summary.pinDataKeys).toBe(2);
  });

  test("sem pinData a chave é omitida da definition", () => {
    const res = imported(wf());
    expect(res.definition).not.toHaveProperty("pinData");
  });

  test("staticData não-vazio é preservado e sinalizado no summary", () => {
    // Act
    const res = imported(wf({ staticData: { node: { lastId: 10 } } }));

    // Assert
    expect(res.definition.staticData).toEqual({ node: { lastId: 10 } });
    expect(res.summary.hasStaticData).toBe(true);
  });

  test("staticData null/vazio não é preservado", () => {
    const a = imported(wf({ staticData: null }));
    const b = imported(wf({ staticData: {} }));
    expect(a.definition).not.toHaveProperty("staticData");
    expect(a.summary.hasStaticData).toBe(false);
    expect(b.definition).not.toHaveProperty("staticData");
    expect(b.summary.hasStaticData).toBe(false);
  });

  test("settings são preservadas e errorWorkflow é sinalizado", () => {
    // Arrange
    const settings = { executionOrder: "v1", timezone: "America/Sao_Paulo", errorWorkflow: "wf-err" };

    // Act
    const res = imported(wf({ settings }));

    // Assert
    expect(res.definition.settings).toEqual(settings);
    expect(res.summary.hasErrorWorkflow).toBe(true);
  });

  test("settings sem errorWorkflow não sinalizam hasErrorWorkflow", () => {
    const res = imported(wf({ settings: { executionOrder: "v1" } }));
    expect(res.summary.hasErrorWorkflow).toBe(false);
  });

  test("settings vazias são omitidas", () => {
    const res = imported(wf({ settings: {} }));
    expect(res.definition).not.toHaveProperty("settings");
  });

  test("tags normalizam objeto[] e string[] pra string[]", () => {
    // Arrange: n8n exporta tags como objetos; versões antigas, como strings.
    const payload = wf({
      tags: [{ id: "1", name: "producao" }, "manual", { id: "2" }, 42],
    });

    // Act
    const res = imported(payload);

    // Assert: entradas sem `name` utilizável são descartadas.
    expect(res.definition.tags).toEqual(["producao", "manual"]);
    expect(res.summary.tagCount).toBe(2);
  });

  test("sem tags a chave é omitida e tagCount é 0", () => {
    const res = imported(wf());
    expect(res.definition).not.toHaveProperty("tags");
    expect(res.summary.tagCount).toBe(0);
  });

  test("versionId vira n8nVersionId", () => {
    const res = imported(wf({ versionId: "v-abc" }));
    expect(res.definition.n8nVersionId).toBe("v-abc");
  });

  test("source.raw preserva o JSON original pra round-trip", () => {
    // Arrange
    const payload = wf({ name: "Original", active: true, meta: { instanceId: "i1" } });

    // Act
    const res = imported(payload);

    // Assert
    expect(res.definition.source.format).toBe("n8n");
    expect(res.definition.source.raw).toMatchObject({ name: "Original", active: true });
    expect(res.definition.source.raw.meta).toEqual({ instanceId: "i1" });
  });

  test("importMeta espelha o summary", () => {
    const payload = wf({
      nodes: [{ id: "a", name: "A", type: "n8n-nodes-base.noOp", parameters: {} }],
    });
    const res = imported(payload);
    expect(res.definition.importMeta).toEqual(res.summary);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// importN8nWorkflow — cenário integrado
// ══════════════════════════════════════════════════════════════════════════

describe("importN8nWorkflow — workflow realista ponta a ponta", () => {
  test("webhook → set → if → http/slack importa nós, edges e expressões", () => {
    // Arrange: workflow n8n realista e completo.
    const payload = {
      name: "Notificar Pedido",
      nodes: [
        {
          id: "wh",
          name: "Webhook",
          type: "n8n-nodes-base.webhook",
          typeVersion: 2,
          position: [1000, 500],
          webhookId: "abc-123",
          parameters: { path: "pedido", httpMethod: "POST" },
        },
        {
          id: "set",
          name: "Preparar",
          type: "n8n-nodes-base.set",
          typeVersion: 3.4,
          position: [1200, 500],
          parameters: {
            assignments: {
              assignments: [
                { name: "total", value: "={{ $json.body.total }}", type: "number" },
                { name: "cliente", value: "={{ $json.body.cliente.nome }}", type: "string" },
              ],
            },
          },
        },
        {
          id: "if",
          name: "Alto Valor",
          type: "n8n-nodes-base.if",
          typeVersion: 2,
          position: [1400, 500],
          parameters: {
            conditions: {
              conditions: [
                {
                  leftValue: "={{ $json.total }}",
                  rightValue: 1000,
                  operator: { operation: "gt", type: "number" },
                },
              ],
            },
          },
        },
        {
          id: "slack",
          name: "Avisar Time",
          type: "n8n-nodes-base.slack",
          position: [1600, 400],
          parameters: { channel: "#vendas", text: "=Pedido de {{ $json.cliente }}" },
        },
        {
          id: "http",
          name: "Registrar",
          type: "n8n-nodes-base.httpRequest",
          position: [1600, 600],
          parameters: { url: "https://api.exemplo.com/log", method: "POST" },
        },
      ],
      connections: {
        Webhook: { main: [[{ node: "Preparar" }]] },
        Preparar: { main: [[{ node: "Alto Valor" }]] },
        "Alto Valor": { main: [[{ node: "Avisar Time" }], [{ node: "Registrar" }]] },
      },
      settings: { executionOrder: "v1" },
      tags: [{ id: "t1", name: "vendas" }],
      versionId: "ver-1",
    };

    // Act
    const res = imported(payload);

    // Assert — nome e contagens
    expect(res.name).toBe("Notificar Pedido");
    expect(res.summary).toMatchObject({ total: 5, mapped: 5, unsupported: 0, skipped: 0 });

    // Assert — tipos internos
    expect(res.definition.nodes.map((n) => n.type)).toEqual([
      "webhook_trigger",
      "set_variable",
      "if",
      "slack_webhook",
      "http_request",
    ]);

    // Assert — expressões reescritas em profundidade
    const setCfg = res.definition.nodes[1].config;
    expect(setCfg.variables).toEqual({
      total: "{{ prev.body.total }}",
      cliente: "{{ prev.body.cliente.nome }}",
    });
    expect(setCfg._types).toEqual({ total: "number", cliente: "string" });
    expect(res.definition.nodes[3].config.text).toBe("Pedido de {{ prev.cliente }}");

    // Assert — edges com labels do if
    expect(res.definition.edges).toEqual([
      { from: "wh", to: "set", label: undefined },
      { from: "set", to: "if", label: undefined },
      { from: "if", to: "slack", label: "true" },
      { from: "if", to: "http", label: "false" },
    ]);

    // Assert — posições normalizadas (offset [1000, 400])
    expect(
      (res.definition.nodes[0].config._editor as { position: unknown }).position,
    ).toEqual({ x: 0, y: 100 });
  });

  test("workflow com nós de IA (agent + modelo + memória) mapeia portas LangChain", () => {
    // Arrange
    const payload = {
      name: "Agente",
      nodes: [
        {
          id: "ag",
          name: "AI Agent",
          type: "@n8n/n8n-nodes-langchain.agent",
          parameters: { text: "={{ $json.pergunta }}", options: { systemMessage: "Seja breve." } },
        },
        {
          id: "lm",
          name: "Modelo",
          type: "@n8n/n8n-nodes-langchain.lmChatAnthropic",
          parameters: { model: { value: "claude-opus-4-1" } },
        },
        {
          id: "mem",
          name: "Memoria",
          type: "@n8n/n8n-nodes-langchain.memoryPostgresChat",
          parameters: { sessionKey: "={{ $json.userId }}", tableName: "chat" },
        },
        {
          id: "calc",
          name: "Calculadora",
          type: "@n8n/n8n-nodes-langchain.toolCalculator",
          parameters: {},
        },
      ],
      connections: {
        Modelo: { ai_languageModel: [[{ node: "AI Agent" }]] },
        Memoria: { ai_memory: [[{ node: "AI Agent" }]] },
        Calculadora: { ai_tool: [[{ node: "AI Agent" }]] },
      },
    };

    // Act
    const res = imported(payload);

    // Assert
    expect(res.summary).toMatchObject({ mapped: 4, unsupported: 0 });
    expect(res.definition.nodes.map((n) => n.type)).toEqual([
      "ai_agent",
      "ai_chat",
      "chat_memory",
      "noop",
    ]);
    expect(res.definition.nodes[1].config.provider).toBe("anthropic");
    expect(res.definition.nodes[2].config.sessionId).toBe("{{ prev.userId }}");
    expect(res.definition.edges.map((e) => e.label)).toEqual([
      "ai_languageModel",
      "ai_memory",
      "ai_tool",
    ]);
  });
});
