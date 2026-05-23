import { t } from "elysia";

// Chaves no padrão "ENV_VAR_NAME" — letras maiúsculas, dígitos e underscore.
const keyPattern = "^[A-Z_][A-Z0-9_]{0,127}$";

export const createVariableBody = t.Object({
  key: t.String({ pattern: keyPattern, minLength: 1, maxLength: 128 }),
  value: t.String({ maxLength: 8192 }),
  isSecret: t.Optional(t.Boolean()),
});

export const updateVariableBody = t.Object({
  value: t.Optional(t.String({ maxLength: 8192 })),
  isSecret: t.Optional(t.Boolean()),
});

// `id` é o id do ambiente (consistente com o environmentsRouter — o Memoirist
// não permite dois nomes pra mesma posição na árvore de rotas).
export const variableListParams = t.Object({
  id: t.String({ format: "uuid" }),
});

export const variableParams = t.Object({
  id: t.String({ format: "uuid" }),
  variableId: t.String({ format: "uuid" }),
});

export const variableListQuery = t.Object({
  // Quando true, devolve o valor real dos secrets (precisa de auth — futuro: permissão).
  reveal: t.Optional(t.BooleanString()),
});

export type CreateVariableBody = typeof createVariableBody.static;
export type UpdateVariableBody = typeof updateVariableBody.static;
