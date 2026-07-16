import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { telegramSendHandler } from "../src/lib/engine/nodes/telegram-send";
import type { ExecutionContext, WorkflowNode } from "../src/lib/engine/types";

/**
 * Testes do nó `telegram_send`. Não tocam a Bot API: `globalThis.fetch` é
 * substituído por um stub que registra a chamada e devolve uma resposta
 * roteirizada.
 *
 * Cobrem: validação de config, montagem do payload da Bot API (incluindo o
 * mapeamento camelCase → snake_case), os opcionais que só entram quando têm o
 * tipo certo, e as três formas de falha (HTTP não-ok, `ok:false` no corpo, e
 * corpo ilegível).
 *
 * O token é fictício — a Bot API leva o token no path da URL, então os testes
 * também fixam esse formato.
 */

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[];
let realFetch: typeof globalThis.fetch;

const TOKEN = "123456:FAKE-TOKEN-DE-TESTE";
const API_URL = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

/** Resposta de sucesso típica da Bot API. */
function okResponse(result: Record<string, unknown> = { message_id: 42 }) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(responder: () => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return responder();
  }) as typeof globalThis.fetch;
}

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return { input: {}, vars: {}, env: {}, steps: {}, prev: {}, ...overrides };
}

function node(config: Record<string, unknown>): WorkflowNode {
  return { id: "n1", type: "telegram_send", config };
}

async function run(config: Record<string, unknown>, context: ExecutionContext = ctx()) {
  return telegramSendHandler({ node: node(config), context });
}

/** Config mínima válida, com override pontual por teste. */
function cfg(overrides: Record<string, unknown> = {}) {
  return { botToken: TOKEN, chatId: "-100123", text: "olá", ...overrides };
}

/** O body enviado é sempre JSON — devolve já parseado. */
function sentPayload(call: FetchCall): Record<string, unknown> {
  return JSON.parse(call.init.body as string);
}

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("telegram_send — validação de config", () => {
  test("botToken ausente lança erro", async () => {
    stubFetch(okResponse);
    await expect(run({ chatId: "1", text: "oi" })).rejects.toThrow(
      "telegram_send: config.botToken é obrigatório",
    );
  });

  test("botToken vazio lança erro", async () => {
    stubFetch(okResponse);
    await expect(run(cfg({ botToken: "" }))).rejects.toThrow(/botToken é obrigatório/);
  });

  test("botToken não-string lança erro", async () => {
    stubFetch(okResponse);
    await expect(run(cfg({ botToken: 123 }))).rejects.toThrow(/botToken é obrigatório/);
  });

  test("chatId ausente lança erro", async () => {
    stubFetch(okResponse);
    await expect(run({ botToken: TOKEN, text: "oi" })).rejects.toThrow(
      "telegram_send: config.chatId é obrigatório",
    );
  });

  test("chatId null lança erro", async () => {
    stubFetch(okResponse);
    await expect(run(cfg({ chatId: null }))).rejects.toThrow(/chatId é obrigatório/);
  });

  test("chatId string vazia lança erro localmente", async () => {
    // Antes escapava do guard e só falhava na Bot API, como `chat not found`.
    stubFetch(okResponse);
    await expect(run(cfg({ chatId: "" }))).rejects.toThrow(/chatId é obrigatório/);
    expect(calls).toHaveLength(0);
  });

  test("chatId numérico 0 é aceito — o guard de número é por tipo", async () => {
    stubFetch(okResponse);
    await run(cfg({ chatId: 0 }));
    expect(sentPayload(calls[0]).chat_id).toBe(0);
  });

  test("text ausente lança erro", async () => {
    stubFetch(okResponse);
    await expect(run({ botToken: TOKEN, chatId: "1" })).rejects.toThrow(
      "telegram_send: config.text é obrigatório",
    );
  });

  test("text vazio lança erro", async () => {
    stubFetch(okResponse);
    await expect(run(cfg({ text: "" }))).rejects.toThrow(/text é obrigatório/);
  });

  test("nenhuma requisição é feita quando a validação falha", async () => {
    stubFetch(okResponse);
    await expect(run({})).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("telegram_send — montagem da requisição", () => {
  test("chama o endpoint sendMessage com o token no path", async () => {
    stubFetch(okResponse);
    await run(cfg());
    expect(calls[0].url).toBe(API_URL);
  });

  test("usa POST com content-type JSON", async () => {
    stubFetch(okResponse);
    await run(cfg());
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ "content-type": "application/json" });
  });

  test("payload mínimo carrega chat_id e text", async () => {
    stubFetch(okResponse);
    await run(cfg({ chatId: "-100123", text: "olá mundo" }));
    expect(sentPayload(calls[0])).toEqual({ chat_id: "-100123", text: "olá mundo" });
  });

  test("chatId numérico é preservado como número", async () => {
    stubFetch(okResponse);
    await run(cfg({ chatId: 987 }));
    expect(sentPayload(calls[0]).chat_id).toBe(987);
  });
});

describe("telegram_send — opções da Bot API", () => {
  test("parseMode vira parse_mode", async () => {
    stubFetch(okResponse);
    await run(cfg({ parseMode: "HTML" }));
    expect(sentPayload(calls[0]).parse_mode).toBe("HTML");
  });

  test("disableNotification vira disable_notification", async () => {
    stubFetch(okResponse);
    await run(cfg({ disableNotification: true }));
    expect(sentPayload(calls[0]).disable_notification).toBe(true);
  });

  test("disableWebPagePreview vira disable_web_page_preview", async () => {
    stubFetch(okResponse);
    await run(cfg({ disableWebPagePreview: true }));
    expect(sentPayload(calls[0]).disable_web_page_preview).toBe(true);
  });

  test("flags booleanas false são enviadas explicitamente", async () => {
    stubFetch(okResponse);
    await run(cfg({ disableNotification: false }));
    // `false` é um valor legítimo — o guard é por tipo, não por truthiness.
    expect(sentPayload(calls[0])).toHaveProperty("disable_notification", false);
  });

  test("opcionais omitidos não aparecem no payload", async () => {
    stubFetch(okResponse);
    await run(cfg());
    const payload = sentPayload(calls[0]);
    expect(payload).not.toHaveProperty("parse_mode");
    expect(payload).not.toHaveProperty("disable_notification");
    expect(payload).not.toHaveProperty("disable_web_page_preview");
  });

  test("opcionais com tipo errado são ignorados", async () => {
    stubFetch(okResponse);
    await run(cfg({ parseMode: 42, disableNotification: "sim", disableWebPagePreview: 1 }));
    const payload = sentPayload(calls[0]);
    expect(payload).not.toHaveProperty("parse_mode");
    expect(payload).not.toHaveProperty("disable_notification");
    expect(payload).not.toHaveProperty("disable_web_page_preview");
  });

  test("todas as opções juntas", async () => {
    stubFetch(okResponse);
    await run(
      cfg({ parseMode: "MarkdownV2", disableNotification: true, disableWebPagePreview: false }),
    );
    expect(sentPayload(calls[0])).toEqual({
      chat_id: "-100123",
      text: "olá",
      parse_mode: "MarkdownV2",
      disable_notification: true,
      disable_web_page_preview: false,
    });
  });
});

describe("telegram_send — output", () => {
  test("sucesso expõe ok, messageId e result", async () => {
    stubFetch(() => okResponse({ message_id: 99, chat: { id: -100123 } }));
    const res = await run(cfg());
    expect(res.output).toEqual({
      ok: true,
      messageId: 99,
      result: { message_id: 99, chat: { id: -100123 } },
    });
  });

  test("result sem message_id devolve messageId null", async () => {
    stubFetch(() => okResponse({ chat: { id: 1 } }));
    const res = await run(cfg());
    expect(res.output.messageId).toBeNull();
  });

  test("resposta ok sem result devolve messageId e result null", async () => {
    stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await run(cfg());
    expect(res.output).toEqual({ ok: true, messageId: null, result: null });
  });
});

describe("telegram_send — erros da Bot API", () => {
  test("ok:false no corpo lança mesmo com HTTP 200", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 200 }),
    );
    await expect(run(cfg())).rejects.toThrow(/chat not found/);
  });

  test("401 de token inválido lança com status e corpo", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), {
          status: 401,
        }),
    );
    await expect(run(cfg())).rejects.toThrow(/telegram_send: 401/);
  });

  test("5xx lança", async () => {
    stubFetch(() => new Response(JSON.stringify({ ok: false }), { status: 500 }));
    await expect(run(cfg())).rejects.toThrow(/telegram_send: 500/);
  });

  test("corpo ilegível não quebra o handler — vira erro tratado", async () => {
    // `.json()` rejeita e o handler cai no catch → body null → erro de envio.
    stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(run(cfg())).rejects.toThrow(/telegram_send: 502/);
  });

  test("HTTP 200 com corpo ilegível também lança", async () => {
    stubFetch(() => new Response("não é json", { status: 200 }));
    await expect(run(cfg())).rejects.toThrow(/telegram_send: 200/);
  });

  test("erro de rede propaga", async () => {
    // O node não tem retry — erro de transporte sobe direto pro executor.
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(run(cfg())).rejects.toThrow("ECONNREFUSED");
  });
});

describe("telegram_send — interpolação de template", () => {
  test("text resolve {{ }} contra o contexto", async () => {
    stubFetch(okResponse);
    await run(cfg({ text: "Run {{ input.runId }} falhou" }), ctx({ input: { runId: "r-7" } }));
    expect(sentPayload(calls[0]).text).toBe("Run r-7 falhou");
  });

  test("botToken e chatId resolvem a partir de env", async () => {
    stubFetch(okResponse);
    await run(
      cfg({ botToken: "{{ env.TG_TOKEN }}", chatId: "{{ env.TG_CHAT }}" }),
      ctx({ env: { TG_TOKEN: TOKEN, TG_CHAT: "-555" } }),
    );
    expect(calls[0].url).toBe(API_URL);
    expect(sentPayload(calls[0]).chat_id).toBe("-555");
  });

  test("text resolve a partir do output do step anterior", async () => {
    stubFetch(okResponse);
    await run(cfg({ text: "{{ prev.mensagem }}" }), ctx({ prev: { mensagem: "vindo do prev" } }));
    expect(sentPayload(calls[0]).text).toBe("vindo do prev");
  });
});
