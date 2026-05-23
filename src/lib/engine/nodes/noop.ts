import type { NodeHandler } from "../types";

/** Pass-through. Não faz nada — útil pra simplificar topologia. */
export const noopHandler: NodeHandler = async () => ({ output: {} });
