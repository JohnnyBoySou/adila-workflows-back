import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { discordWebhookHandler } from "../src/lib/engine/nodes/discord-webhook";
import { slackWebhookHandler } from "../src/lib/engine/nodes/slack-webhook";
import type {
  ExecutionContext,
  NodeHandler,
  NodeType,
  WorkflowNode,
} from "../src/lib/engine/types";

/**
 * Testes dos nós `slack_webhook` e `discord_webhook` — os dois postam JSON num
 * Incoming Webhook e têm a mesma forma, então compartilham o stub de `fetch`.
 * Nada sai para a rede; as URLs são fictícias.
 *
 * Cobrem: validação da URL e do "ao menos um conteúdo", montagem do payload
 * (com o mapeamento camelCase → snake_case), os opcionais que só entram quando
 * o tipo bate, e o caminho de erro HTTP.
 *
 * As diferenças entre os dois estão fixadas: o Slack lê o corpo sempre e o
 * devolve em `response`; o Discord só lê no erro e responde 204 sem corpo.
 */

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[];
let realFetch: typeof globalThis.fetch;

const SLACK_URL = "https://hooks.slack.com/services/T000/B000/xxxx";
const DISCORD_URL = "https://discord.com/api/webhooks/123/xxxx";

function stubFetch(responder: () => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return responder();
  }) as typeof globalThis.fetch;
}

/** Slack responde "ok" em text/plain; Discord responde 204 sem corpo. */
const slackOk = () => new Response("ok", { status: 200 });
const discordOk = () => new Response(null, { status: 204 });

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return { input: {}, vars: {}, env: {}, steps: {}, prev: {}, ...overrides };
}

function runner(handler: NodeHandler, type: NodeType) {
  return (config: Record<string, unknown>, context: ExecutionContext = ctx()) => {
    const node: WorkflowNode = { id: "n1", type, config };
    return handler({ node, context });
  };
}

const runSlack = runner(slackWebhookHandler, "slack_webhook");
const runDiscord = runner(discordWebhookHandler, "discord_webhook");

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

// --------------------------------------------------------------- slack

describe("slack_webhook — validação", () => {
  test("webhookUrl ausente lança erro", async () => {
    stubFetch(slackOk);
    await expect(runSlack({ text: "oi" })).rejects.toThrow(
      "slack_webhook: config.webhookUrl é obrigatório",
    );
  });

  test("webhookUrl vazia lança erro", async () => {
    stubFetch(slackOk);
    await expect(runSlack({ webhookUrl: "", text: "oi" })).rejects.toThrow(
      /webhookUrl é obrigatório/,
    );
  });

  test("webhookUrl não-string lança erro", async () => {
    stubFetch(slackOk);
    await expect(runSlack({ webhookUrl: 42, text: "oi" })).rejects.toThrow(
      /webhookUrl é obrigatório/,
    );
  });

  test("sem text e sem blocks lança erro", async () => {
    stubFetch(slackOk);
    await expect(runSlack({ webhookUrl: SLACK_URL })).rejects.toThrow(
      "slack_webhook: defina ao menos config.text ou config.blocks",
    );
  });

  test("text null e blocks null lança erro", async () => {
    stubFetch(slackOk);
    await expect(runSlack({ webhookUrl: SLACK_URL, text: null, blocks: null })).rejects.toThrow(
      /ao menos config.text ou config.blocks/,
    );
  });

  test("só blocks é suficiente", async () => {
    stubFetch(slackOk);
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "oi" } }];
    await runSlack({ webhookUrl: SLACK_URL, blocks });
    expect(sentPayload(calls[0])).toEqual({ blocks });
  });

  test("nenhuma requisição é feita quando a validação falha", async () => {
    stubFetch(slackOk);
    await expect(runSlack({})).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("slack_webhook — payload", () => {
  test("posta JSON via POST na URL do webhook", async () => {
    stubFetch(slackOk);
    await runSlack({ webhookUrl: SLACK_URL, text: "oi" });
    expect(calls[0].url).toBe(SLACK_URL);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ "content-type": "application/json" });
  });

  test("text simples", async () => {
    stubFetch(slackOk);
    await runSlack({ webhookUrl: SLACK_URL, text: "deploy concluído" });
    expect(sentPayload(calls[0])).toEqual({ text: "deploy concluído" });
  });

  test("iconEmoji vira icon_emoji", async () => {
    stubFetch(slackOk);
    await runSlack({ webhookUrl: SLACK_URL, text: "oi", iconEmoji: ":rocket:" });
    expect(sentPayload(calls[0]).icon_emoji).toBe(":rocket:");
  });

  test("username e channel são repassados", async () => {
    stubFetch(slackOk);
    await runSlack({ webhookUrl: SLACK_URL, text: "oi", username: "bot", channel: "#geral" });
    const payload = sentPayload(calls[0]);
    expect(payload.username).toBe("bot");
    expect(payload.channel).toBe("#geral");
  });

  test("opcionais com tipo errado são ignorados", async () => {
    stubFetch(slackOk);
    await runSlack({ webhookUrl: SLACK_URL, text: "oi", username: 1, iconEmoji: 2, channel: 3 });
    expect(sentPayload(calls[0])).toEqual({ text: "oi" });
  });

  test("blocks e text convivem no mesmo payload", async () => {
    stubFetch(slackOk);
    const blocks = [{ type: "divider" }];
    await runSlack({ webhookUrl: SLACK_URL, text: "fallback", blocks });
    expect(sentPayload(calls[0])).toEqual({ text: "fallback", blocks });
  });

  test("blocks aceita objeto, não só array", async () => {
    stubFetch(slackOk);
    // O guard é `!= null`, não `Array.isArray` — diferente do Discord.
    await runSlack({ webhookUrl: SLACK_URL, blocks: { type: "divider" } });
    expect(sentPayload(calls[0])).toEqual({ blocks: { type: "divider" } });
  });

  test("QUIRK: text não-string passa na validação mas some do payload", async () => {
    stubFetch(slackOk);
    // `cfg.text == null` é false pra 42, então a validação passa; mas o payload
    // só copia text quando é string — o Slack recebe `{}` e nada é postado.
    await runSlack({ webhookUrl: SLACK_URL, text: 42 });
    expect(sentPayload(calls[0])).toEqual({});
  });
});

describe("slack_webhook — resposta", () => {
  test("sucesso expõe status, ok e o corpo em response", async () => {
    stubFetch(slackOk);
    const res = await runSlack({ webhookUrl: SLACK_URL, text: "oi" });
    expect(res.output).toEqual({ status: 200, ok: true, response: "ok" });
  });

  test("erro HTTP lança com status e corpo", async () => {
    stubFetch(() => new Response("invalid_payload", { status: 400 }));
    await expect(runSlack({ webhookUrl: SLACK_URL, text: "oi" })).rejects.toThrow(
      "slack_webhook: 400 invalid_payload",
    );
  });

  test("404 de webhook revogado lança", async () => {
    stubFetch(() => new Response("no_service", { status: 404 }));
    await expect(runSlack({ webhookUrl: SLACK_URL, text: "oi" })).rejects.toThrow(/404 no_service/);
  });

  test("5xx lança", async () => {
    stubFetch(() => new Response("server_error", { status: 500 }));
    await expect(runSlack({ webhookUrl: SLACK_URL, text: "oi" })).rejects.toThrow(/500/);
  });

  test("erro de rede propaga", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(runSlack({ webhookUrl: SLACK_URL, text: "oi" })).rejects.toThrow("ECONNREFUSED");
  });
});

describe("slack_webhook — template", () => {
  test("text resolve {{ }} contra o contexto", async () => {
    stubFetch(slackOk);
    await runSlack(
      { webhookUrl: SLACK_URL, text: "Run {{ input.runId }} falhou" },
      ctx({ input: { runId: "r-9" } }),
    );
    expect(sentPayload(calls[0]).text).toBe("Run r-9 falhou");
  });

  test("webhookUrl resolve a partir de env", async () => {
    stubFetch(slackOk);
    await runSlack(
      { webhookUrl: "{{ env.SLACK_URL }}", text: "oi" },
      ctx({ env: { SLACK_URL: SLACK_URL } }),
    );
    expect(calls[0].url).toBe(SLACK_URL);
  });
});

// ------------------------------------------------------------- discord

describe("discord_webhook — validação", () => {
  test("webhookUrl ausente lança erro", async () => {
    stubFetch(discordOk);
    await expect(runDiscord({ content: "oi" })).rejects.toThrow(
      "discord_webhook: config.webhookUrl é obrigatório",
    );
  });

  test("webhookUrl vazia lança erro", async () => {
    stubFetch(discordOk);
    await expect(runDiscord({ webhookUrl: "", content: "oi" })).rejects.toThrow(
      /webhookUrl é obrigatório/,
    );
  });

  test("sem content e sem embeds lança erro", async () => {
    stubFetch(discordOk);
    await expect(runDiscord({ webhookUrl: DISCORD_URL })).rejects.toThrow(
      "discord_webhook: defina ao menos config.content ou config.embeds",
    );
  });

  test("só embeds é suficiente", async () => {
    stubFetch(discordOk);
    const embeds = [{ title: "Deploy", description: "ok" }];
    await runDiscord({ webhookUrl: DISCORD_URL, embeds });
    expect(sentPayload(calls[0])).toEqual({ embeds });
  });

  test("nenhuma requisição é feita quando a validação falha", async () => {
    stubFetch(discordOk);
    await expect(runDiscord({})).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("discord_webhook — payload", () => {
  test("posta JSON via POST na URL do webhook", async () => {
    stubFetch(discordOk);
    await runDiscord({ webhookUrl: DISCORD_URL, content: "oi" });
    expect(calls[0].url).toBe(DISCORD_URL);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ "content-type": "application/json" });
  });

  test("content simples", async () => {
    stubFetch(discordOk);
    await runDiscord({ webhookUrl: DISCORD_URL, content: "deploy concluído" });
    expect(sentPayload(calls[0])).toEqual({ content: "deploy concluído" });
  });

  test("avatarUrl vira avatar_url", async () => {
    stubFetch(discordOk);
    await runDiscord({
      webhookUrl: DISCORD_URL,
      content: "oi",
      avatarUrl: "https://exemplo.com/a.png",
    });
    expect(sentPayload(calls[0]).avatar_url).toBe("https://exemplo.com/a.png");
  });

  test("username e tts são repassados", async () => {
    stubFetch(discordOk);
    await runDiscord({ webhookUrl: DISCORD_URL, content: "oi", username: "bot", tts: true });
    const payload = sentPayload(calls[0]);
    expect(payload.username).toBe("bot");
    expect(payload.tts).toBe(true);
  });

  test("tts false é enviado explicitamente", async () => {
    stubFetch(discordOk);
    await runDiscord({ webhookUrl: DISCORD_URL, content: "oi", tts: false });
    expect(sentPayload(calls[0])).toHaveProperty("tts", false);
  });

  test("opcionais com tipo errado são ignorados", async () => {
    stubFetch(discordOk);
    await runDiscord({ webhookUrl: DISCORD_URL, content: "oi", username: 1, avatarUrl: 2, tts: 3 });
    expect(sentPayload(calls[0])).toEqual({ content: "oi" });
  });

  test("embeds não-array é descartado do payload", async () => {
    stubFetch(discordOk);
    // Aqui o guard é `Array.isArray` — mais estrito que o `!= null` do Slack.
    // O objeto passa na validação mas não entra no payload.
    await runDiscord({ webhookUrl: DISCORD_URL, embeds: { title: "x" } });
    expect(sentPayload(calls[0])).toEqual({});
  });

  test("content e embeds convivem", async () => {
    stubFetch(discordOk);
    const embeds = [{ title: "t" }];
    await runDiscord({ webhookUrl: DISCORD_URL, content: "oi", embeds });
    expect(sentPayload(calls[0])).toEqual({ content: "oi", embeds });
  });
});

describe("discord_webhook — resposta", () => {
  test("204 sem corpo é sucesso e não expõe response", async () => {
    stubFetch(discordOk);
    const res = await runDiscord({ webhookUrl: DISCORD_URL, content: "oi" });
    expect(res.output).toEqual({ status: 204, ok: true });
  });

  test("200 também é sucesso", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    const res = await runDiscord({ webhookUrl: DISCORD_URL, content: "oi" });
    expect(res.output).toEqual({ status: 200, ok: true });
  });

  test("erro HTTP lança com status e corpo", async () => {
    stubFetch(() => new Response('{"message":"Invalid Webhook Token"}', { status: 401 }));
    await expect(runDiscord({ webhookUrl: DISCORD_URL, content: "oi" })).rejects.toThrow(
      /discord_webhook: 401 .*Invalid Webhook Token/,
    );
  });

  test("429 de rate limit lança", async () => {
    stubFetch(() => new Response('{"retry_after":5}', { status: 429 }));
    await expect(runDiscord({ webhookUrl: DISCORD_URL, content: "oi" })).rejects.toThrow(/429/);
  });

  test("erro de rede propaga", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(runDiscord({ webhookUrl: DISCORD_URL, content: "oi" })).rejects.toThrow(
      "ECONNREFUSED",
    );
  });
});

describe("discord_webhook — template", () => {
  test("content resolve {{ }} contra o contexto", async () => {
    stubFetch(discordOk);
    await runDiscord(
      { webhookUrl: DISCORD_URL, content: "Run {{ input.runId }} falhou" },
      ctx({ input: { runId: "r-3" } }),
    );
    expect(sentPayload(calls[0]).content).toBe("Run r-3 falhou");
  });

  test("embeds resolvem template em profundidade", async () => {
    stubFetch(discordOk);
    await runDiscord(
      { webhookUrl: DISCORD_URL, embeds: [{ title: "{{ input.titulo }}" }] },
      ctx({ input: { titulo: "Alerta" } }),
    );
    expect(sentPayload(calls[0]).embeds).toEqual([{ title: "Alerta" }]);
  });
});
