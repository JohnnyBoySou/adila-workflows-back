import { environmentsRepository } from "./repository";
import type { CreateEnvironmentBody, UpdateEnvironmentBody } from "./schema";

export const environmentsController = {
  list(organizationId: string) {
    return environmentsRepository.list(organizationId);
  },

  findById(organizationId: string, id: string) {
    return environmentsRepository.findById(organizationId, id);
  },

  async create(organizationId: string, body: CreateEnvironmentBody) {
    // Slug único por org — validamos antes pra devolver erro semântico.
    const existing = await environmentsRepository.findBySlug(organizationId, body.slug);
    if (existing) return { error: "slug_taken" as const };

    const created = await environmentsRepository.create({
      organizationId,
      slug: body.slug,
      name: body.name,
      kind: body.kind ?? "development",
      description: body.description,
      isDefault: body.isDefault ?? false,
    });

    if (created.isDefault) {
      await environmentsRepository.clearDefaultExcept(organizationId, created.id);
    }
    return { environment: created };
  },

  async update(organizationId: string, id: string, body: UpdateEnvironmentBody) {
    if (body.slug) {
      const existing = await environmentsRepository.findBySlug(organizationId, body.slug);
      if (existing && existing.id !== id) return { error: "slug_taken" as const };
    }

    const updated = await environmentsRepository.update(organizationId, id, {
      ...(body.slug !== undefined && { slug: body.slug }),
      ...(body.name !== undefined && { name: body.name }),
      ...(body.kind !== undefined && { kind: body.kind }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.isDefault !== undefined && { isDefault: body.isDefault }),
    });
    if (!updated) return { error: "not_found" as const };

    if (body.isDefault === true) {
      await environmentsRepository.clearDefaultExcept(organizationId, updated.id);
    }
    return { environment: updated };
  },

  remove(organizationId: string, id: string) {
    return environmentsRepository.remove(organizationId, id);
  },
};
