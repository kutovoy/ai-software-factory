import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import {
  DEFAULT_PRESIGN_EXPIRY_SECONDS,
  MAX_PRESIGN_EXPIRY_SECONDS,
  amzTimestamp,
  awsUriEncode,
  deriveSigningKey,
  presignS3Get,
  presignS3Put,
  presignS3Url,
} from '../src/s3-presign';

/**
 * SigV4 presigning (ADR-047). Deterministic clock + credentials, and the signature is
 * re-derived here from the published algorithm so a regression in the module cannot be
 * "snapshotted away".
 */

const FIXED_NOW = new Date('2026-11-04T00:00:00.000Z');

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

/** Independent SigV4 query-string signature, written from the AWS spec. */
function expectedSignature(input: {
  method: string;
  canonicalUri: string;
  canonicalQuery: string;
  canonicalHeaders: string;
  signedHeaders: string;
  amzDate: string;
  scope: string;
  secretKey: string;
  region: string;
}): string {
  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    input.canonicalQuery,
    input.canonicalHeaders,
    input.signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    input.amzDate,
    input.scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const dateStamp = input.amzDate.slice(0, 8);
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.secretKey}`, dateStamp), input.region), 's3'),
    'aws4_request',
  );
  return createHmac('sha256', key).update(stringToSign).digest('hex');
}

describe('awsUriEncode', () => {
  test('encodes AWS-unsafe characters and keeps unreserved ones', () => {
    expect(awsUriEncode('a b/c')).toBe('a%20b%2Fc');
    expect(awsUriEncode('a b/c', false)).toBe('a%20b/c');
    expect(awsUriEncode("!'()*")).toBe('%21%27%28%29%2A');
    expect(awsUriEncode('AZaz09-_.~')).toBe('AZaz09-_.~');
  });
});

describe('amzTimestamp', () => {
  test('renders the SigV4 basic ISO-8601 form', () => {
    expect(amzTimestamp(FIXED_NOW)).toBe('20261104T000000Z');
  });
});

describe('presignS3Url', () => {
  const base = {
    endpoint: 'http://localhost:9000',
    bucket: 'factory-artifacts',
    key: 'tenants/default/runs/run_1/patch.diff',
    accessKey: 'minio',
    secretKey: 'minio-secret',
    now: FIXED_NOW,
  };

  test('GET presigns a path-style MinIO URL with a spec-correct signature', () => {
    const result = presignS3Get(base);

    const canonicalUri = '/factory-artifacts/tenants/default/runs/run_1/patch.diff';
    const canonicalQuery = [
      'X-Amz-Algorithm=AWS4-HMAC-SHA256',
      'X-Amz-Credential=minio%2F20261104%2Fus-east-1%2Fs3%2Faws4_request',
      'X-Amz-Date=20261104T000000Z',
      'X-Amz-Expires=900',
      'X-Amz-SignedHeaders=host',
    ].join('&');

    expect(result.canonicalRequest).toBe(
      [
        'GET',
        canonicalUri,
        canonicalQuery,
        'host:localhost:9000\n',
        'host',
        'UNSIGNED-PAYLOAD',
      ].join('\n'),
    );
    expect(result.signature).toBe(
      expectedSignature({
        method: 'GET',
        canonicalUri,
        canonicalQuery,
        canonicalHeaders: 'host:localhost:9000\n',
        signedHeaders: 'host',
        amzDate: '20261104T000000Z',
        scope: '20261104/us-east-1/s3/aws4_request',
        secretKey: 'minio-secret',
        region: 'us-east-1',
      }),
    );
    expect(result.url).toBe(
      `http://localhost:9000${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${result.signature}`,
    );
    expect(result.headers).toEqual({});
  });

  test('PUT signs content-type and returns the header the uploader must send', () => {
    const result = presignS3Put({ ...base, contentType: 'text/x-diff; charset=utf-8' });

    expect(result.canonicalRequest).toContain('content-type:text/x-diff; charset=utf-8\nhost:localhost:9000\n');
    expect(result.canonicalRequest).toContain('content-type;host');
    expect(result.headers['content-type']).toBe('text/x-diff; charset=utf-8');

    const signature = expectedSignature({
      method: 'PUT',
      canonicalUri: '/factory-artifacts/tenants/default/runs/run_1/patch.diff',
      canonicalQuery: [
        'X-Amz-Algorithm=AWS4-HMAC-SHA256',
        'X-Amz-Credential=minio%2F20261104%2Fus-east-1%2Fs3%2Faws4_request',
        'X-Amz-Date=20261104T000000Z',
        'X-Amz-Expires=900',
        'X-Amz-SignedHeaders=content-type%3Bhost',
      ].join('&'),
      canonicalHeaders: 'content-type:text/x-diff; charset=utf-8\nhost:localhost:9000\n',
      signedHeaders: 'content-type;host',
      amzDate: '20261104T000000Z',
      scope: '20261104/us-east-1/s3/aws4_request',
      secretKey: 'minio-secret',
      region: 'us-east-1',
    });
    expect(result.signature).toBe(signature);
  });

  test('content-length is signed when supplied', () => {
    const result = presignS3Put({ ...base, contentType: 'application/octet-stream', contentLength: 42 });
    expect(result.canonicalRequest).toContain('content-length:42\n');
    expect(result.canonicalRequest).toContain('content-length;content-type;host');
    expect(result.headers['content-length']).toBe('42');
  });

  test('virtual-host style puts the bucket in the host', () => {
    const result = presignS3Get({ ...base, forcePathStyle: false });
    expect(result.url.startsWith('http://factory-artifacts.localhost:9000/tenants/')).toBe(true);
    expect(result.canonicalRequest).toContain('\n/tenants/default/runs/run_1/patch.diff\n');
    expect(result.canonicalRequest).toContain('host:factory-artifacts.localhost:9000\n');
  });

  test('encodes spaces and special characters in key segments', () => {
    const result = presignS3Get({ ...base, key: 'runs/run 1/report (final).log' });
    expect(result.canonicalRequest).toContain('/factory-artifacts/runs/run%201/report%20%28final%29.log');
  });

  test('a base path on the endpoint is preserved', () => {
    const result = presignS3Get({ ...base, endpoint: 'https://proxy.example.com/s3/' });
    expect(result.url.startsWith('https://proxy.example.com/s3/factory-artifacts/')).toBe(true);
  });

  test('clamps expiry to the SigV4 bounds', () => {
    expect(presignS3Get({ ...base, expiresInSeconds: 0 }).url).toContain('X-Amz-Expires=1&');
    expect(presignS3Get({ ...base, expiresInSeconds: 999_999 }).url).toContain(
      `X-Amz-Expires=${MAX_PRESIGN_EXPIRY_SECONDS}&`,
    );
    expect(presignS3Get(base).url).toContain(`X-Amz-Expires=${DEFAULT_PRESIGN_EXPIRY_SECONDS}&`);
  });

  test('includes a session token when one is supplied', () => {
    const result = presignS3Get({ ...base, sessionToken: 'sts-token' });
    expect(result.url).toContain('X-Amz-Security-Token=sts-token');
  });

  test('refuses missing credentials and non-http endpoints', () => {
    expect(() => presignS3Url({ ...base, method: 'GET', accessKey: '' })).toThrow(/accessKey/);
    expect(() => presignS3Url({ ...base, method: 'GET', secretKey: '' })).toThrow(/secretKey/);
    expect(() => presignS3Url({ ...base, method: 'GET', bucket: '' })).toThrow(/bucket/);
    expect(() => presignS3Url({ ...base, method: 'GET', endpoint: 'ftp://minio' })).toThrow(
      /unsupported/,
    );
  });

  test('matches the published AWS SigV4 query-string example', () => {
    // AWS docs example (GET object, virtual-host style):
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const result = presignS3Get({
      endpoint: 'https://s3.amazonaws.com',
      bucket: 'examplebucket',
      key: 'test.txt',
      accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      expiresInSeconds: 86_400,
      forcePathStyle: false,
      now: new Date('2013-05-24T00:00:00.000Z'),
    });
    expect(result.signature).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
    expect(result.url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  test('deriveSigningKey is deterministic', () => {
    const a = deriveSigningKey('secret', '20261104', 'us-east-1');
    const b = deriveSigningKey('secret', '20261104', 'us-east-1');
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
  });
});
