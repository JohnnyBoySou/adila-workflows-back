import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { httpRequestHandler } from "../src/lib/engine/nodes/http-request";
import type { ExecutionContext, WorkflowNode } from "../src/lib/engine/types";

/**
 * Testes do nó `http_request`. Não fazem rede: `globalThis.fetch` é substituído
 * por um stub que registra as chamadas e devolve respostas roteirizadas.
 *
 * Cobrem: normalização de método/URL, os quatro modos de body, os cinco tipos
 * de auth, precedência de headers explícitos, query params, parsing da resposta
 * e o orçamento de retry (5xx e erro de rede).
 */

interface FetchCall {
  url: string;
  init: RequestInit & { proxy?: string; tls?: { rejectUnauthorized?: boolean } };
}

let calls: FetchCall[];
let realFetch: typeof globalThis.fetch;

/**
 * Instala um fetch stub. `responder` recebe o índice da tentativa (1-based) e
 * devolve a Response daquela tentativa — ou lança, simulando erro de rede.
 */
function stubFetch(responder: (attempt: number) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: (init ?? {}) as FetchCall["init"] });
    return await responder(calls.length);
  }) as typeof globalThis.fetch;
}

/** Atalho: sempre a mesma resposta, independente da tentativa. */
function stubOnce(body: string, init: ResponseInit = { status: 200 }) {
  stubFetch(() => new Response(body, init));
}

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return { input: {}, vars: {}, env: {}, steps: {}, prev: {}, ...overrides };
}

function node(config: Record<string, unknown>): WorkflowNode {
  return { id: "n1", type: "http_request", config };
}

async function run(config: Record<string, unknown>, context: ExecutionContext = ctx()) {
  return httpRequestHandler({ node: node(config), context });
}

/** Headers chegam ao fetch como Record simples — o handler monta um objeto. */
function sentHeaders(call: FetchCall): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("http_request — validação e método", () => {
  test("url ausente lança erro", async () => {
    stubOnce("{}");
    await expect(run({})).rejects.toThrow("http_request: config.url é obrigatório");
  });

  test("url vazia lança erro", async () => {
    stubOnce("{}");
    await expect(run({ url: "" })).rejects.toThrow("config.url é obrigatório");
  });

  test("url não-string lança erro", async () => {
    stubOnce("{}");
    await expect(run({ url: 42 })).rejects.toThrow("config.url é obrigatório");
  });

  test("método default é GET", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com" });
    expect(calls[0].init.method).toBe("GET");
  });

  test("método é normalizado para maiúsculas", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", method: "post" });
    expect(calls[0].init.method).toBe("POST");
  });

  test("método vazio cai no default GET", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", method: "   " });
    expect(calls[0].init.method).toBe("GET");
  });

  test("GET ignora o body configurado", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", method: "GET", body: { a: 1 } });
    expect(calls[0].init.body).toBeUndefined();
  });

  test("HEAD ignora o body configurado", async () => {
    stubOnce("");
    await run({ url: "https://api.exemplo.com", method: "HEAD", body: { a: 1 } });
    expect(calls[0].init.body).toBeUndefined();
  });
});

describe("http_request — query params", () => {
  test("queryParams viram query string", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com/x", queryParams: { page: "2", limit: "10" } });
    expect(calls[0].url).toBe("https://api.exemplo.com/x?page=2&limit=10");
  });

  test("sem queryParams a URL fica intacta", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com/x" });
    expect(calls[0].url).toBe("https://api.exemplo.com/x");
  });

  test("query existente na URL é preservada e concatenada com &", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com/x?já=1", queryParams: { novo: "2" } });
    expect(calls[0].url).toBe("https://api.exemplo.com/x?já=1&novo=2");
  });

  test("chaves e valores são percent-encoded", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", queryParams: { "a b": "c&d" } });
    expect(calls[0].url).toBe("https://api.exemplo.com?a%20b=c%26d");
  });

  test("valores não-string são coagidos; null/undefined são descartados", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      queryParams: { n: 7, nulo: null, indef: undefined },
    });
    expect(calls[0].url).toBe("https://api.exemplo.com?n=7");
  });
});

describe("http_request — auth", () => {
  test("basic monta Authorization com base64 de user:pass", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      auth: { type: "basic", username: "ada", password: "s3nha" },
    });
    const esperado = Buffer.from("ada:s3nha").toString("base64");
    expect(sentHeaders(calls[0]).authorization).toBe(`Basic ${esperado}`);
  });

  test("basic sem credenciais usa string vazia dos dois lados", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", auth: { type: "basic" } });
    const esperado = Buffer.from(":").toString("base64");
    expect(sentHeaders(calls[0]).authorization).toBe(`Basic ${esperado}`);
  });

  test("bearer monta Authorization com o token", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", auth: { type: "bearer", token: "tok-123" } });
    expect(sentHeaders(calls[0]).authorization).toBe("Bearer tok-123");
  });

  test("bearer sem token não emite header", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", auth: { type: "bearer" } });
    expect(sentHeaders(calls[0]).authorization).toBeUndefined();
  });

  test("api_key default vai no header", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      auth: { type: "api_key", apiKeyName: "X-Api-Key", apiKeyValue: "k-1" },
    });
    expect(sentHeaders(calls[0])["X-Api-Key"]).toBe("k-1");
  });

  test("api_key com apiKeyIn=query vai na query string", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      auth: { type: "api_key", apiKeyName: "key", apiKeyValue: "k-1", apiKeyIn: "query" },
    });
    expect(calls[0].url).toBe("https://api.exemplo.com?key=k-1");
    expect(sentHeaders(calls[0]).key).toBeUndefined();
  });

  test("api_key sem name ou value é ignorado", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", auth: { type: "api_key", apiKeyName: "k" } });
    expect(sentHeaders(calls[0])).toEqual({});
  });

  test("oauth2 usa oauthToken como Bearer", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", auth: { type: "oauth2", oauthToken: "oa-9" } });
    expect(sentHeaders(calls[0]).authorization).toBe("Bearer oa-9");
  });

  test("type none não emite header", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", auth: { type: "none" } });
    expect(sentHeaders(calls[0])).toEqual({});
  });

  test("type desconhecido é tratado como none", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", auth: { type: "kerberos", token: "x" } });
    expect(sentHeaders(calls[0])).toEqual({});
  });

  test("auth não-objeto é tratado como none", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", auth: "bearer x" });
    expect(sentHeaders(calls[0])).toEqual({});
  });

  test("headers explícitos sobrescrevem o que o auth produziu", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      auth: { type: "bearer", token: "do-auth" },
      headers: { authorization: "Bearer explícito" },
    });
    expect(sentHeaders(calls[0]).authorization).toBe("Bearer explícito");
  });
});

describe("http_request — body", () => {
  test("mode json serializa objeto e seta Content-Type", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      method: "POST",
      body: { mode: "json", content: { a: 1 } },
    });
    expect(calls[0].init.body).toBe('{"a":1}');
    expect(sentHeaders(calls[0])["content-type"]).toBe("application/json");
  });

  test("mode json com string passa a string crua adiante", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      method: "POST",
      body: { mode: "json", content: '{"já":"serializado"}' },
    });
    expect(calls[0].init.body).toBe('{"já":"serializado"}');
  });

  test("mode json com content vazio não envia body nem Content-Type", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      method: "POST",
      body: { mode: "json", content: "" },
    });
    expect(calls[0].init.body).toBeUndefined();
    expect(sentHeaders(calls[0])["content-type"]).toBeUndefined();
  });

  test("mode json com content null não envia body", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      method: "POST",
      body: { mode: "json", content: null },
    });
    expect(calls[0].init.body).toBeUndefined();
  });

  test("mode form vira URLSearchParams e seta Content-Type de form", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      method: "POST",
      body: { mode: "form", content: { a: "1", b: "2" } },
    });
    const body = calls[0].init.body as URLSearchParams;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(body.toString()).toBe("a=1&b=2");
    expect(sentHeaders(calls[0])["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  test("mode form descarta valores null e coage não-strings", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      method: "POST",
      body: { mode: "form", content: { n: 5, nulo: null } },
    });
    expect((calls[0].init.body as URLSearchParams).toString()).toBe("n=5");
  });

  test("mode raw usa rawContentType", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      method: "POST",
      body: { mode: "raw", content: "<xml/>", rawContentType: "application/xml" },
    });
    expect(calls[0].init.body).toBe("<xml/>");
    expect(sentHeaders(calls[0])["content-type"]).toBe("application/xml");
  });

  test("mode raw sem rawContentType não força Content-Type", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      method: "POST",
      body: { mode: "raw", content: "texto" },
    });
    expect(calls[0].init.body).toBe("texto");
    expect(sentHeaders(calls[0])["content-type"]).toBeUndefined();
  });

  test("mode raw com content null não envia body", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      method: "POST",
      body: { mode: "raw", content: null },
    });
    expect(calls[0].init.body).toBeUndefined();
  });

  test("mode multipart vira FormData e remove Content-Type manual", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      method: "POST",
      headers: { "content-type": "vai/sumir" },
      body: { mode: "multipart", content: { campo: "valor" } },
    });
    const body = calls[0].init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("campo")).toBe("valor");
    // O boundary precisa ser gerado pelo fetch — Content-Type manual é removido.
    expect(sentHeaders(calls[0])["content-type"]).toBeUndefined();
  });

  test("mode desconhecido cai no json", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      method: "POST",
      body: { mode: "protobuf", content: { a: 1 } },
    });
    expect(calls[0].init.body).toBe('{"a":1}');
    expect(sentHeaders(calls[0])["content-type"]).toBe("application/json");
  });

  test("shape legado string vai como texto puro sem Content-Type", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", method: "POST", body: "cru" });
    expect(calls[0].init.body).toBe("cru");
    expect(sentHeaders(calls[0])["content-type"]).toBeUndefined();
  });

  test("shape legado objeto vira JSON", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", method: "POST", body: { a: 1 } });
    expect(calls[0].init.body).toBe('{"a":1}');
    expect(sentHeaders(calls[0])["content-type"]).toBe("application/json");
  });

  test("Content-Type explícito do usuário vence o implícito do modo", async () => {
    stubOnce("{}");
    await run({
      url: "https://api.exemplo.com",
      method: "POST",
      headers: { "content-type": "application/vnd.api+json" },
      body: { mode: "json", content: { a: 1 } },
    });
    expect(sentHeaders(calls[0])["content-type"]).toBe("application/vnd.api+json");
  });
});

describe("http_request — opções de transporte", () => {
  test("followRedirects default segue redirecionamentos", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com" });
    expect(calls[0].init.redirect).toBe("follow");
  });

  test("followRedirects false usa redirect manual", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", followRedirects: false });
    expect(calls[0].init.redirect).toBe("manual");
  });

  test("proxy é repassado ao fetch", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", proxy: "http://proxy.local:3128" });
    expect(calls[0].init.proxy).toBe("http://proxy.local:3128");
  });

  test("proxy vazio não é repassado", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", proxy: "" });
    expect(calls[0].init.proxy).toBeUndefined();
  });

  test("skipSslVerify desliga a verificação de certificado", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", skipSslVerify: true });
    expect(calls[0].init.tls).toEqual({ rejectUnauthorized: false });
  });

  test("sem skipSslVerify a opção tls não é enviada", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com" });
    expect(calls[0].init.tls).toBeUndefined();
  });

  test("o fetch recebe um AbortSignal para o timeout", async () => {
    stubOnce("{}");
    await run({ url: "https://api.exemplo.com", timeoutMs: 5000 });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("http_request — parsing da resposta", () => {
  test("corpo JSON é parseado", async () => {
    stubOnce('{"nome":"ada"}');
    const res = await run({ url: "https://api.exemplo.com" });
    expect(res.output.body).toEqual({ nome: "ada" });
  });

  test("corpo não-JSON permanece texto", async () => {
    stubOnce("não é json");
    const res = await run({ url: "https://api.exemplo.com" });
    expect(res.output.body).toBe("não é json");
  });

  test("corpo vazio vira null", async () => {
    stubOnce("");
    const res = await run({ url: "https://api.exemplo.com" });
    expect(res.output.body).toBeNull();
  });

  test("status e ok são expostos", async () => {
    stubOnce('{"ok":true}', { status: 201 });
    const res = await run({ url: "https://api.exemplo.com" });
    expect(res.output.status).toBe(201);
    expect(res.output.ok).toBe(true);
  });

  test("headers da resposta viram objeto plano", async () => {
    stubOnce("{}", { status: 200, headers: { "x-custom": "abc" } });
    const res = await run({ url: "https://api.exemplo.com" });
    expect((res.output.headers as Record<string, string>)["x-custom"]).toBe("abc");
  });

  test("4xx é resposta legítima — não lança e não faz retry", async () => {
    stubOnce('{"erro":"não encontrado"}', { status: 404 });
    const res = await run({ url: "https://api.exemplo.com", retry: { count: 3, delayMs: 0 } });
    expect(res.output.status).toBe(404);
    expect(res.output.ok).toBe(false);
    expect(res.output.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("attempts é 1 quando não houve retry", async () => {
    stubOnce("{}");
    const res = await run({ url: "https://api.exemplo.com" });
    expect(res.output.attempts).toBe(1);
  });
});

describe("http_request — retry", () => {
  test("5xx dispara retry e o sucesso seguinte é retornado", async () => {
    stubFetch((attempt) =>
      attempt === 1 ? new Response("erro", { status: 503 }) : new Response('{"ok":1}'),
    );
    const res = await run({ url: "https://api.exemplo.com", retry: { count: 2, delayMs: 0 } });
    expect(res.output.status).toBe(200);
    expect(res.output.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  test("5xx persistente devolve a última resposta após esgotar o budget", async () => {
    stubFetch(() => new Response("indisponível", { status: 500 }));
    const res = await run({ url: "https://api.exemplo.com", retry: { count: 2, delayMs: 0 } });
    expect(res.output.status).toBe(500);
    expect(res.output.attempts).toBe(3);
    expect(calls).toHaveLength(3);
  });

  test("sem retry configurado o 5xx retorna na primeira tentativa", async () => {
    stubFetch(() => new Response("erro", { status: 500 }));
    const res = await run({ url: "https://api.exemplo.com" });
    expect(res.output.status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  test("erro de rede entra no budget de retry e o sucesso seguinte vence", async () => {
    stubFetch((attempt) => {
      if (attempt === 1) throw new Error("ECONNREFUSED");
      return new Response('{"ok":1}');
    });
    const res = await run({ url: "https://api.exemplo.com", retry: { count: 1, delayMs: 0 } });
    expect(res.output.attempts).toBe(2);
  });

  test("erro de rede persistente propaga após esgotar o budget", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      run({ url: "https://api.exemplo.com", retry: { count: 1, delayMs: 0 } }),
    ).rejects.toThrow("ECONNREFUSED");
    expect(calls).toHaveLength(2);
  });

  test("count é limitado a 10", async () => {
    stubFetch(() => new Response("erro", { status: 500 }));
    const res = await run({ url: "https://api.exemplo.com", retry: { count: 999, delayMs: 0 } });
    expect(res.output.attempts).toBe(11);
  });

  test("count negativo é normalizado para zero", async () => {
    stubFetch(() => new Response("erro", { status: 500 }));
    const res = await run({ url: "https://api.exemplo.com", retry: { count: -5, delayMs: 0 } });
    expect(calls).toHaveLength(1);
    expect(res.output.attempts).toBe(1);
  });

  test("retry não-objeto é ignorado", async () => {
    stubFetch(() => new Response("erro", { status: 500 }));
    await run({ url: "https://api.exemplo.com", retry: "3" });
    expect(calls).toHaveLength(1);
  });
});

describe("http_request — interpolação de template", () => {
  test("a URL resolve {{ }} contra o contexto", async () => {
    stubOnce("{}");
    await run(
      { url: "https://api.exemplo.com/users/{{ input.id }}" },
      ctx({ input: { id: "42" } }),
    );
    expect(calls[0].url).toBe("https://api.exemplo.com/users/42");
  });

  test("o token de auth resolve a partir de env", async () => {
    stubOnce("{}");
    await run(
      { url: "https://api.exemplo.com", auth: { type: "bearer", token: "{{ env.TOKEN }}" } },
      ctx({ env: { TOKEN: "secreto-de-teste" } }),
    );
    expect(sentHeaders(calls[0]).authorization).toBe("Bearer secreto-de-teste");
  });
});
