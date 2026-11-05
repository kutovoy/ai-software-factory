import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 query-string presigning for S3-compatible stores (ADR-047).
 *
 * The control plane hands agents short-lived presigned PUT/GET URLs instead of object-store
 * credentials. This module is deliberately dependency-free (no AWS SDK): RustFS, S3 and R2
 * all accept the same SigV4 query-string form, and path-style addressing is the default
 * because that is what a self-hosted RustFS serves.
 *
 * Reference: <https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html>
 */

export type S3PresignMethod = 'GET' | 'PUT' | 'HEAD' | 'DELETE';

export interface S3PresignInput {
  method: S3PresignMethod;
  /** S3 API endpoint, e.g. `http://localhost:9000` or `https://s3.example.com`. */
  endpoint: string;
  bucket: string;
  /** Object key (not URL-encoded; the signer encodes each segment). */
  key: string;
  accessKey: string;
  secretKey: string;
  region?: string;
  /** Grant lifetime in seconds (1–604800; S3 rejects more than 7 days). */
  expiresInSeconds?: number;
  /** RustFS default: `/bucket/key` instead of `bucket.host/key`. */
  forcePathStyle?: boolean;
  /** Signed when provided; the uploader must send the exact same header value. */
  contentType?: string;
  /** Signed when provided; the uploader must send the exact same content length. */
  contentLength?: number;
  sessionToken?: string;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

export interface S3PresignResult {
  url: string;
  /** Headers the caller must send with the presigned request (signed headers only). */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export const DEFAULT_S3_REGION = 'us-east-1';
export const DEFAULT_PRESIGN_EXPIRY_SECONDS = 900;
export const MIN_PRESIGN_EXPIRY_SECONDS = 1;
export const MAX_PRESIGN_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/**
 * AWS's URI encoding: every byte except `A-Z a-z 0-9 - _ . ~` is percent-encoded. Unlike
 * `encodeURIComponent`, `!'()*` are encoded too, and `/` is kept only when asked.
 */
export function awsUriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const isUnreserved =
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2d || // -
      byte === 0x5f || // _
      byte === 0x2e || // .
      byte === 0x7e; // ~
    if (isUnreserved) {
      out += String.fromCharCode(byte);
    } else if (byte === 0x2f && !encodeSlash) {
      out += '/';
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** `2026-11-04T12:34:56.000Z` → `20261104T123456Z` (the SigV4 basic ISO-8601 form). */
export function amzTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** The HMAC chain: date → region → service → `aws4_request`. */
export function deriveSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service = SERVICE,
): Buffer {
  const kDate = createHmac('sha256', `AWS4${secretKey}`).update(dateStamp).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update(service).digest();
  return createHmac('sha256', kService).update('aws4_request').digest();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function clampExpiry(seconds: number | undefined): number {
  const parsed = Number.isFinite(seconds) ? Math.trunc(seconds as number) : DEFAULT_PRESIGN_EXPIRY_SECONDS;
  return Math.min(Math.max(parsed, MIN_PRESIGN_EXPIRY_SECONDS), MAX_PRESIGN_EXPIRY_SECONDS);
}

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required for S3 presigning`);
  }
  return value;
}

/** Builds a presigned URL plus the signed-request diagnostics (used by tests). */
export function presignS3Url(input: S3PresignInput): S3PresignResult {
  const bucket = requireText(input.bucket, 'bucket');
  const key = requireText(input.key, 'key');
  const accessKey = requireText(input.accessKey, 'accessKey');
  const secretKey = requireText(input.secretKey, 'secretKey');

  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error(`unsupported S3 endpoint protocol "${endpoint.protocol}"`);
  }

  const region = input.region?.trim() || DEFAULT_S3_REGION;
  const forcePathStyle = input.forcePathStyle ?? true;
  const now = input.now ?? new Date();
  const amzDate = amzTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);
  const expiresIn = clampExpiry(input.expiresInSeconds);

  const basePath = endpoint.pathname.replace(/\/+$/, '');
  const host = forcePathStyle ? endpoint.host : `${bucket}.${endpoint.host}`;
  const objectPath = forcePathStyle ? `/${bucket}/${key}` : `/${key}`;
  const canonicalUri = awsUriEncode(`${basePath}${objectPath}`, false);

  const signedHeaderValues: Record<string, string> = { host };
  if (input.contentType !== undefined && input.contentType !== '') {
    signedHeaderValues['content-type'] = input.contentType.trim();
  }
  if (input.contentLength !== undefined) {
    signedHeaderValues['content-length'] = String(input.contentLength);
  }
  const signedHeaderNames = Object.keys(signedHeaderValues).sort();
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${signedHeaderValues[name] as string}\n`)
    .join('');

  const credentialScope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const query: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${accessKey}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  if (input.sessionToken) query['X-Amz-Security-Token'] = input.sessionToken;

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${awsUriEncode(name)}=${awsUriEncode(query[name] as string)}`)
    .join('&');

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = deriveSigningKey(secretKey, dateStamp, region);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const url = `${endpoint.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;

  const headers: Record<string, string> = {};
  if (signedHeaderValues['content-type']) headers['content-type'] = signedHeaderValues['content-type'];
  if (signedHeaderValues['content-length']) {
    headers['content-length'] = signedHeaderValues['content-length'];
  }

  return { url, headers, canonicalRequest, stringToSign, signature };
}

/** Presigned PUT grant for an artifact upload. */
export function presignS3Put(input: Omit<S3PresignInput, 'method'>): S3PresignResult {
  return presignS3Url({ ...input, method: 'PUT' });
}

/** Presigned GET grant for an artifact download. */
export function presignS3Get(input: Omit<S3PresignInput, 'method'>): S3PresignResult {
  return presignS3Url({ ...input, method: 'GET' });
}
