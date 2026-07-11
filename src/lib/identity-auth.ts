import { and, eq } from "drizzle-orm";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { env } from "../config/env";
import { db } from "../db";
import { member, organization, user } from "../db/auth-schema";
import { logger } from "./logger";

/**
 * Federated auth against the Adila Identity service.
 *
 * The front authenticates at `identity.adila.co` and sends a short-lived JWT as
 * `Authorization: Bearer <token>`. Here we verify it **statelessly** against
 * Identity's published JWKS (no call back to Identity) and, on success,
 * just-in-time provision a local `user`/`organization`/`member` row using the
 * SAME ids Identity issued — so every domain foreign key (which points at these
 * tables) keeps resolving without a migration.
 */

const IDENTITY_ISSUER = env.IDENTITY_ISSUER ?? env.IDENTITY_URL;
const JWKS_URL = new URL("/api/auth/jwks", env.IDENTITY_URL);

// Cached remote key set: jose fetches the JWKS once, caches the keys, and
// refetches only on an unknown `kid` (key rotation). Reused across requests.
const jwks = createRemoteJWKSet(JWKS_URL);

/** Claims the Identity JWT carries (see identity `definePayload`). */
export interface IdentityClaims {
  userId: string;
  email: string;
  name: string;
  /** Platform role (admin plugin), not the org role. */
  platformRole: string | null;
  organizationId: string | null;
  organizationRole: string | null;
  organizationName: string | null;
}

export class IdentityAuthError extends Error {}

function claimString(payload: JWTPayload, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Verify an Identity JWT and extract its claims. Throws `IdentityAuthError` on
 * any invalid/expired/mis-issued token — callers map that to a 401.
 */
export async function verifyIdentityToken(token: string): Promise<IdentityClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: IDENTITY_ISSUER,
      audience: env.IDENTITY_JWT_AUDIENCE,
    }));
  } catch (error) {
    throw new IdentityAuthError(error instanceof Error ? error.message : "invalid token");
  }

  const userId = claimString(payload, "sub");
  if (!userId) throw new IdentityAuthError("token missing sub");

  return {
    userId,
    email: claimString(payload, "email") ?? "",
    name: claimString(payload, "name") ?? "",
    platformRole: claimString(payload, "role"),
    organizationId: claimString(payload, "activeOrganizationId"),
    organizationRole: claimString(payload, "activeOrganizationRole"),
    organizationName: claimString(payload, "activeOrganizationName"),
  };
}

// Skip re-provisioning the same (user, org, role) tuple for a short window so
// the hot path isn't a DB write on every request. Identity is the source of
// truth; a stale role self-heals within the TTL (and on the next token, which
// refreshes every ~15min anyway).
const PROVISION_TTL_MS = 5 * 60 * 1000;
const provisioned = new Map<string, number>();

/** Deterministic membership id so re-provisioning upserts the same row. */
const memberId = (organizationId: string, userId: string) => `${organizationId}__${userId}`;

/**
 * Mirror the Identity user (and their active org + membership) into the local
 * auth tables, preserving Identity's ids. Idempotent and best-effort-cached.
 */
export async function provisionLocalIdentity(claims: IdentityClaims): Promise<void> {
  const cacheKey = `${claims.userId}:${claims.organizationId}:${claims.organizationRole}`;
  const cached = provisioned.get(cacheKey);
  const now = Date.now();
  if (cached && cached > now) return;

  const timestamp = new Date();

  await db
    .insert(user)
    .values({
      id: claims.userId,
      name: claims.name || claims.email || claims.userId,
      email: claims.email || `${claims.userId}@identity.adila.co`,
      emailVerified: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: user.id,
      set: {
        name: claims.name || claims.email || claims.userId,
        email: claims.email,
        updatedAt: timestamp,
      },
    });

  if (claims.organizationId) {
    await db
      .insert(organization)
      .values({
        id: claims.organizationId,
        // Local org rows back the tenancy foreign keys; the display name/slug are
        // owned by Identity (the front reads them from there). Slug = id keeps the
        // NOT NULL UNIQUE constraint satisfied without a real slug in the token.
        name: claims.organizationName || claims.organizationId,
        slug: claims.organizationId,
        createdAt: timestamp,
      })
      .onConflictDoUpdate({
        target: organization.id,
        set: { name: claims.organizationName || claims.organizationId },
      });

    await db
      .insert(member)
      .values({
        id: memberId(claims.organizationId, claims.userId),
        organizationId: claims.organizationId,
        userId: claims.userId,
        role: claims.organizationRole ?? "member",
        createdAt: timestamp,
      })
      .onConflictDoUpdate({
        target: member.id,
        set: { role: claims.organizationRole ?? "member" },
      });
  }

  provisioned.set(cacheKey, now + PROVISION_TTL_MS);
}

/** Pull the raw Bearer token out of the Authorization header, or `null`. */
export function bearerToken(headers: Headers): string | null {
  const header = headers.get("authorization") ?? headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Verify a raw Identity token and provision the local mirror. Throws
 * `IdentityAuthError` on an invalid token. Used where the token doesn't arrive
 * in an Authorization header — e.g. the realtime WS handshake carries it as a
 * `?token=` query param (browsers can't set headers on a WebSocket upgrade).
 */
export async function authenticateToken(token: string): Promise<IdentityClaims> {
  const claims = await verifyIdentityToken(token);
  try {
    await provisionLocalIdentity(claims);
  } catch (error) {
    // Provisioning failure must not 401 a valid token — log and continue; the
    // membership lookup downstream will surface a real authorization problem.
    logger.error(
      { err: error, userId: claims.userId, organizationId: claims.organizationId },
      "failed to provision local identity",
    );
  }
  return claims;
}

/**
 * Full request auth: pull the Bearer token from the headers, verify it, and
 * provision the local mirror. Throws `IdentityAuthError` when absent/invalid.
 */
export async function authenticateRequest(headers: Headers): Promise<IdentityClaims> {
  const token = bearerToken(headers);
  if (!token) throw new IdentityAuthError("missing bearer token");
  return authenticateToken(token);
}

/** The caller's local org role, from the mirrored membership. */
export async function localMemberRole(
  organizationId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}
