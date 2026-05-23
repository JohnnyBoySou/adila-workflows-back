import { t } from "elysia";
import { workflowRunStatus } from "../../db/schema";

const statusEnum = t.Union(workflowRunStatus.map((s) => t.Literal(s)));

export const listRunsParams = t.Object({
  id: t.String({ format: "uuid" }),
});

export const listRunsQuery = t.Object({
  status: t.Optional(statusEnum),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),
  offset: t.Optional(t.Numeric({ minimum: 0, default: 0 })),
});

export const runParams = t.Object({
  id: t.String({ format: "uuid" }),
  runId: t.String({ format: "uuid" }),
});

export type ListRunsQuery = typeof listRunsQuery.static;
