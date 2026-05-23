import type { NodeHandler } from "../types";

/**
 * Container ("frame" estilo Figma) — agrupamento visual de uma área do canvas.
 * Não executa: o `config` carrega `{ label, bounds: { x, y, width, height }, color? }`
 * e o editor desenha o retângulo. Nós dentro do container são definidos por geometria,
 * não por relação de pai/filho — o container é puramente decorativo.
 */
export const containerHandler: NodeHandler = async () => ({ output: {} });
