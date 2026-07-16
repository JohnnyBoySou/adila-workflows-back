/**
 * Cobertura do `foldersRepository` — CRUD e o filtro hierárquico de `list`,
 * que é o único ponto com lógica condicional (undefined = tudo, null = raiz,
 * string = filhos). Tudo contra Postgres real (testcontainers).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { member, organization, user } from "../src/db/auth-schema";
import { foldersRepository } from "../src/features/folders/repository";

let orgId: string;
let userId: string;
let otherOrgId: string;

beforeAll(async () => {
  userId = crypto.randomUUID();
  orgId = crypto.randomUUID();
  otherOrgId = crypto.randomUUID();

  await db.insert(user).values({
    id: userId,
    name: "Folders Tester",
    email: `folders-${userId}@example.com`,
  });
  await db.insert(organization).values([
    { id: orgId, name: "Folders Org", slug: `folders-${orgId.slice(0, 8)}` },
    { id: otherOrgId, name: "Other Org", slug: `other-${otherOrgId.slice(0, 8)}` },
  ]);
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId,
    role: "owner",
  });
});

function newFolder(name: string, parentId: string | null = null, org = orgId) {
  return foldersRepository.create({ organizationId: org, name, parentId, createdBy: userId });
}

describe("foldersRepository.create", () => {
  test("persiste a pasta e devolve a linha completa", async () => {
    const created = await newFolder("raiz-a");

    expect(created.id).toBeString();
    expect(created.name).toBe("raiz-a");
    expect(created.parentId).toBeNull();
    expect(created.organizationId).toBe(orgId);
    expect(created.createdAt).toBeInstanceOf(Date);
  });
});

describe("foldersRepository.list", () => {
  test("parentId undefined lista raízes e filhas juntas, ordenadas por nome", async () => {
    const listOrg = crypto.randomUUID();
    await db.insert(organization).values({
      id: listOrg,
      name: "List Org",
      slug: `list-${listOrg.slice(0, 8)}`,
    });

    const zeta = await newFolder("zeta", null, listOrg);
    await newFolder("alpha", null, listOrg);
    await newFolder("meio", zeta.id, listOrg);

    const all = await foldersRepository.list({ organizationId: listOrg });

    expect(all.map((f) => f.name)).toEqual(["alpha", "meio", "zeta"]);
  });

  test("parentId null lista apenas as raízes", async () => {
    const rootOrg = crypto.randomUUID();
    await db.insert(organization).values({
      id: rootOrg,
      name: "Root Org",
      slug: `root-${rootOrg.slice(0, 8)}`,
    });

    const pai = await newFolder("pai", null, rootOrg);
    await newFolder("filha", pai.id, rootOrg);

    const roots = await foldersRepository.list({ organizationId: rootOrg, parentId: null });

    expect(roots.map((f) => f.name)).toEqual(["pai"]);
  });

  test("parentId string lista apenas os filhos diretos daquela pasta", async () => {
    const pai = await newFolder("pai-direto");
    const filhaB = await newFolder("b-filha", pai.id);
    const filhaA = await newFolder("a-filha", pai.id);
    await newFolder("neta", filhaA.id);

    const children = await foldersRepository.list({ organizationId: orgId, parentId: pai.id });

    expect(children.map((f) => f.id)).toEqual([filhaA.id, filhaB.id]);
  });

  test("não vaza pastas de outra organização", async () => {
    await newFolder("secreta", null, otherOrgId);

    const visible = await foldersRepository.list({ organizationId: orgId });

    expect(visible.some((f) => f.name === "secreta")).toBe(false);
  });
});

describe("foldersRepository.findById", () => {
  test("encontra a pasta dentro da própria organização", async () => {
    const created = await newFolder("achavel");

    const found = await foldersRepository.findById(orgId, created.id);

    expect(found?.id).toBe(created.id);
  });

  test("devolve null para pasta de outra organização", async () => {
    const alheia = await newFolder("alheia", null, otherOrgId);

    expect(await foldersRepository.findById(orgId, alheia.id)).toBeNull();
  });

  test("devolve null para id inexistente", async () => {
    expect(await foldersRepository.findById(orgId, crypto.randomUUID())).toBeNull();
  });
});

describe("foldersRepository.update", () => {
  test("aplica o patch e mexe o updatedAt", async () => {
    const created = await newFolder("nome-velho");

    const updated = await foldersRepository.update(orgId, created.id, { name: "nome-novo" });

    expect(updated?.name).toBe("nome-novo");
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  test("move a pasta ao trocar o parentId", async () => {
    const destino = await newFolder("destino");
    const movida = await newFolder("movida");

    const updated = await foldersRepository.update(orgId, movida.id, { parentId: destino.id });

    expect(updated?.parentId).toBe(destino.id);
  });

  test("devolve null quando a pasta é de outra organização", async () => {
    const alheia = await newFolder("intocavel", null, otherOrgId);

    const updated = await foldersRepository.update(orgId, alheia.id, { name: "hackeada" });

    expect(updated).toBeNull();
    expect((await foldersRepository.findById(otherOrgId, alheia.id))?.name).toBe("intocavel");
  });
});

describe("foldersRepository.remove", () => {
  test("apaga a pasta e devolve o id removido", async () => {
    const created = await newFolder("descartavel");

    const removed = await foldersRepository.remove(orgId, created.id);

    expect(removed?.id).toBe(created.id);
    expect(await foldersRepository.findById(orgId, created.id)).toBeNull();
  });

  test("devolve null quando a pasta é de outra organização", async () => {
    const alheia = await newFolder("blindada", null, otherOrgId);

    expect(await foldersRepository.remove(orgId, alheia.id)).toBeNull();
    expect(await foldersRepository.findById(otherOrgId, alheia.id)).not.toBeNull();
  });

  test("apagar o pai promove os filhos a raiz (ON DELETE SET NULL)", async () => {
    const pai = await newFolder("pai-condenado");
    const filha = await newFolder("orfa", pai.id);

    await foldersRepository.remove(orgId, pai.id);

    expect((await foldersRepository.findById(orgId, filha.id))?.parentId).toBeNull();
  });
});
