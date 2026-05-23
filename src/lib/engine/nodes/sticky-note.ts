import type { NodeHandler } from "../types";

/**
 * Anotação visual (Markdown) no canvas. Não executa — handler existe só
 * por consistência caso o executor receba uma edge apontando pra ele.
 */
export const stickyNoteHandler: NodeHandler = async () => ({ output: {} });
