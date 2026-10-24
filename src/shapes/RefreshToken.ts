import { Shape } from '@_linked/core/shapes/Shape';
import { linkedShape } from '../package.js';
import * as auth from '../ontologies/auth.js';
import { UserAccount } from '@_linked/sioc/shapes/UserAccount';
import { literalProperty, objectProperty } from '@_linked/core/shapes/SHACL';
import * as xsd from '@_linked/xsd/ontologies/xsd';

/**
 * One issued refresh token, stored server-side so it can be validated, rotated and revoked.
 *
 * Only the SHA-256 hash of the token is stored — the raw token lives on the client alone, so
 * reading the store does not yield usable tokens. Every refresh replaces the token with a new
 * one in the same session (`sessionId`), marking the old one revoked with `replacedBy`.
 * Presenting a replaced token again (outside a short grace window) revokes the whole session.
 *
 * Every property is a decorated getter, so the records are read and written through the query
 * DSL (`RefreshToken.select(...).where(...)`, `RefreshToken.create({...})`,
 * `RefreshToken.update({...}).for(id)`); there are no setters, because shapes are never
 * mutated as live instances. `tokenHash`, `sessionId`, `account`, `createdAt` and `expiresAt`
 * are required, so a create without them fails validation instead of storing a record that
 * can never be matched or expired.
 *
 * This module stays free of server-only imports (it is part of the client bundle); the logic
 * that reads and writes these records lives in `utils/sessions.ts`.
 */
@linkedShape
export class RefreshToken extends Shape {
  static targetClass = auth.RefreshToken;

  /** SHA-256 of the raw refresh token, base64url. */
  @literalProperty({
    path: auth.tokenHash,
    required: true,
    maxCount: 1,
  })
  get tokenHash(): string {
    return '';
  }

  /** The sign-in session (token family) this token belongs to. Shared by every rotation. */
  @literalProperty({
    path: auth.sessionId,
    required: true,
    maxCount: 1,
  })
  get sessionId(): string {
    return '';
  }

  @objectProperty({
    path: auth.account,
    required: true,
    shape: UserAccount,
    maxCount: 1,
  })
  get account(): UserAccount {
    return undefined as any;
  }

  @literalProperty({
    path: auth.createdAt,
    required: true,
    datatype: xsd.dateTime,
    maxCount: 1,
  })
  get createdAt(): Date {
    return undefined as any;
  }

  @literalProperty({
    path: auth.lastUsedAt,
    datatype: xsd.dateTime,
    maxCount: 1,
  })
  get lastUsedAt(): Date {
    return undefined as any;
  }

  @literalProperty({
    path: auth.expiresAt,
    required: true,
    datatype: xsd.dateTime,
    maxCount: 1,
  })
  get expiresAt(): Date {
    return undefined as any;
  }

  /** Set when the token was rotated, signed out or otherwise revoked. */
  @literalProperty({
    path: auth.revokedAt,
    datatype: xsd.dateTime,
    maxCount: 1,
  })
  get revokedAt(): Date {
    return undefined as any;
  }

  /** The `tokenHash` of the token that replaced this one when it was rotated. */
  @literalProperty({
    path: auth.replacedBy,
    maxCount: 1,
  })
  get replacedBy(): string {
    return '';
  }

  /**
   * When the session (the sign-in this token family started with) began. Copied to every
   * rotation, so the absolute session lifetime (`AUTH_SESSION_MAX_TTL`) is checked without
   * loading the family. Optional: records from before it existed fall back to the earliest
   * `createdAt` of their session.
   */
  @literalProperty({
    path: auth.sessionStartedAt,
    datatype: xsd.dateTime,
    maxCount: 1,
  })
  get sessionStartedAt(): Date {
    return undefined as any;
  }
}
