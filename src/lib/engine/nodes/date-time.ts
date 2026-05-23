import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Manipulação de datas — equivalente ao `n8n-nodes-base.dateTime`.
 *
 * Config (discriminado por `operation`):
 *   - now            → output { iso, epochMs }
 *   - parse          → input string + format opcional; output { iso, epochMs }
 *   - format         → input ISO + format ("YYYY-MM-DD HH:mm:ss"); output { formatted }
 *   - add            → ISO + amount + unit (ms/s/m/h/d); output { iso }
 *   - diff           → from + to (ISO); output { ms, seconds, minutes, hours, days }
 *
 * Sem dependência externa — usamos Date nativo + um formatter mínimo.
 */
const PAD = (n: number, w = 2) => String(n).padStart(w, "0");

const FORMAT_TOKENS: Record<string, (d: Date) => string> = {
  YYYY: (d) => String(d.getFullYear()),
  MM: (d) => PAD(d.getMonth() + 1),
  DD: (d) => PAD(d.getDate()),
  HH: (d) => PAD(d.getHours()),
  mm: (d) => PAD(d.getMinutes()),
  ss: (d) => PAD(d.getSeconds()),
  SSS: (d) => PAD(d.getMilliseconds(), 3),
};

function formatDate(d: Date, fmt: string): string {
  // Tokens são substituídos em ordem decrescente de tamanho pra evitar choque.
  return fmt.replaceAll(/YYYY|SSS|MM|DD|HH|mm|ss/g, (token) => FORMAT_TOKENS[token]!(d));
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  seconds: 1000,
  m: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  days: 86_400_000,
};

export const dateTimeHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = cfg.operation;

  if (op === "now") {
    const d = new Date();
    return { output: { iso: d.toISOString(), epochMs: d.getTime() } };
  }

  if (op === "parse") {
    const value = String(cfg.value ?? "");
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`date_time parse: valor inválido "${value}"`);
    }
    return { output: { iso: d.toISOString(), epochMs: d.getTime() } };
  }

  if (op === "format") {
    const value = String(cfg.value ?? "");
    const fmt = typeof cfg.format === "string" ? cfg.format : "YYYY-MM-DD HH:mm:ss";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`date_time format: valor inválido "${value}"`);
    }
    return { output: { formatted: formatDate(d, fmt) } };
  }

  if (op === "add") {
    const value = String(cfg.value ?? "");
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`date_time add: valor inválido "${value}"`);
    }
    const amount = Number(cfg.amount);
    if (!Number.isFinite(amount)) {
      throw new Error("date_time add: amount precisa ser número");
    }
    const unit = typeof cfg.unit === "string" ? cfg.unit : "seconds";
    const ms = UNIT_MS[unit];
    if (!ms) throw new Error(`date_time add: unit "${unit}" não suportado`);
    const next = new Date(d.getTime() + amount * ms);
    return { output: { iso: next.toISOString(), epochMs: next.getTime() } };
  }

  if (op === "diff") {
    const from = new Date(String(cfg.from ?? ""));
    const to = new Date(String(cfg.to ?? ""));
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new Error("date_time diff: from/to inválidos");
    }
    const ms = to.getTime() - from.getTime();
    return {
      output: {
        ms,
        seconds: ms / 1000,
        minutes: ms / 60_000,
        hours: ms / 3_600_000,
        days: ms / 86_400_000,
      },
    };
  }

  throw new Error(`date_time: operation "${String(op)}" não suportada`);
};
