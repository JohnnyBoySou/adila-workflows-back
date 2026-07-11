import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { renderTemplate } from "../template";
import type { ExecutionContext, NodeHandler } from "../types";

/**
 * Operações em buckets S3-compatíveis (AWS, R2, MinIO, Spaces).
 *
 * Credenciais e bucket vêm das **variáveis de ambiente do workflow**
 * (`context.env`), seguindo o mesmo padrão de isolamento por environment
 * que os nós `postgres`/`redis` usam pra connection strings. Nada de
 * plaintext na `config` JSONB.
 *
 * Env vars reconhecidas (padrão AWS):
 *   AWS_S3_BUCKET_NAME       — bucket default
 *   AWS_DEFAULT_REGION       — região (default "us-east-1")
 *   AWS_ENDPOINT_URL         — opcional (R2/MinIO/Spaces)
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   AWS_S3_FORCE_PATH_STYLE  — "true" ativa path-style (MinIO)
 *
 * Config (do nó):
 *   operation: "get" | "put" | "delete" | "list" | "head"
 *   bucket?: string                  — override do env S3_BUCKET
 *   key?:    string                  — get/put/delete/head
 *   prefix?: string                  — list
 *   value?:  string                  — put (corpo)
 *   contentType?: string             — put (default text/plain)
 *   region?: string                  — override
 *   endpoint?: string                — override
 */
export const s3Handler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = cfg.operation;

  const bucket = (typeof cfg.bucket === "string" && cfg.bucket) || context.env?.AWS_S3_BUCKET_NAME;
  if (!bucket) {
    throw new Error(
      "s3: bucket ausente — defina config.bucket ou a env var AWS_S3_BUCKET_NAME do workflow",
    );
  }

  const client = buildClient(cfg, context);

  if (op === "get") {
    const key = requireKey(cfg, "get");
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = res.Body ? await res.Body.transformToString("utf8") : "";
    return {
      output: {
        body,
        contentType: res.ContentType ?? null,
        contentLength: res.ContentLength ?? null,
        etag: res.ETag ?? null,
        lastModified: res.LastModified?.toISOString() ?? null,
      },
    };
  }

  if (op === "put") {
    const key = requireKey(cfg, "put");
    if (typeof cfg.value !== "string") throw new Error("s3.put: config.value deve ser string");
    const res = await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: cfg.value,
        ContentType: typeof cfg.contentType === "string" ? cfg.contentType : "text/plain",
      }),
    );
    return { output: { etag: res.ETag ?? null, versionId: res.VersionId ?? null } };
  }

  if (op === "delete") {
    const key = requireKey(cfg, "delete");
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return { output: { deleted: true } };
  }

  if (op === "head") {
    const key = requireKey(cfg, "head");
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      output: {
        exists: true,
        contentType: res.ContentType ?? null,
        contentLength: res.ContentLength ?? null,
        etag: res.ETag ?? null,
        lastModified: res.LastModified?.toISOString() ?? null,
      },
    };
  }

  if (op === "list") {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ...(typeof cfg.prefix === "string" && { Prefix: cfg.prefix }),
      }),
    );
    return {
      output: {
        keys: (res.Contents ?? []).map((o) => ({
          key: o.Key,
          size: o.Size,
          etag: o.ETag,
          lastModified: o.LastModified?.toISOString() ?? null,
        })),
        isTruncated: res.IsTruncated ?? false,
      },
    };
  }

  throw new Error("s3: config.operation deve ser get/put/delete/list/head");
};

function buildClient(cfg: Record<string, unknown>, context: ExecutionContext): S3Client {
  const env = context.env ?? {};
  const region =
    (typeof cfg.region === "string" && cfg.region) || env.AWS_DEFAULT_REGION || "us-east-1";
  const endpoint =
    (typeof cfg.endpoint === "string" && cfg.endpoint) || env.AWS_ENDPOINT_URL || undefined;
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  const forcePathStyle = env.AWS_S3_FORCE_PATH_STYLE === "true";

  return new S3Client({
    region,
    ...(endpoint && { endpoint }),
    ...(forcePathStyle && { forcePathStyle: true }),
    ...(accessKeyId &&
      secretAccessKey && {
        credentials: { accessKeyId, secretAccessKey },
      }),
  });
}

function requireKey(cfg: Record<string, unknown>, op: string): string {
  if (typeof cfg.key !== "string" || !cfg.key) {
    throw new Error(`s3.${op}: config.key é obrigatório`);
  }
  return cfg.key;
}
