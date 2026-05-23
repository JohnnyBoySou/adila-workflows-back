import { foldersRepository } from "./repository";
import type { CreateFolderBody, ListFoldersQuery, UpdateFolderBody } from "./schema";

// "root" no querystring vira filtro por parentId IS NULL.
function parseParentFilter(raw: ListFoldersQuery["parentId"]) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "root") return null;
  return raw;
}

export const foldersController = {
  list(organizationId: string, query: ListFoldersQuery) {
    return foldersRepository.list({
      organizationId,
      parentId: parseParentFilter(query.parentId),
    });
  },

  findById(organizationId: string, id: string) {
    return foldersRepository.findById(organizationId, id);
  },

  async create(organizationId: string, userId: string, body: CreateFolderBody) {
    // Valida que o pai (se informado) pertence à mesma org.
    if (body.parentId) {
      const parent = await foldersRepository.findById(organizationId, body.parentId);
      if (!parent) return null;
    }
    return foldersRepository.create({
      organizationId,
      createdBy: userId,
      name: body.name,
      parentId: body.parentId ?? null,
    });
  },

  async update(organizationId: string, id: string, body: UpdateFolderBody) {
    // Previne ciclo trivial: pasta apontando pra si mesma como pai.
    if (body.parentId === id) return null;
    if (body.parentId) {
      const parent = await foldersRepository.findById(organizationId, body.parentId);
      if (!parent) return null;
    }
    return foldersRepository.update(organizationId, id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.parentId !== undefined && { parentId: body.parentId }),
    });
  },

  remove(organizationId: string, id: string) {
    return foldersRepository.remove(organizationId, id);
  },
};
