import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { verifyIntakeSignature } from '../src/intake';

function hmac(secret: string, raw: string): string {
  return createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
}

describe('intake signature verification', () => {
  test('generic HMAC accepts the matching signature and rejects a mismatch', () => {
    const raw = '{"title":"Fix the bug"}';
    const secret = 'intake-secret';
    expect(
      verifyIntakeSignature('generic', raw, { 'x-factory-signature': `sha256=${hmac(secret, raw)}` }, secret),
    ).toBe(true);
    expect(
      verifyIntakeSignature('generic', raw, { 'x-factory-signature': `sha256=${hmac('other', raw)}` }, secret),
    ).toBe(false);
  });

  test('Slack v0 signature uses timestamp + raw body', () => {
    const raw = 'text=fix+the+bug';
    const secret = 'slack-secret';
    const timestamp = '1700000000';
    const signature = `v0=${hmac(secret, `v0:${timestamp}:${raw}`)}`;
    expect(
      verifyIntakeSignature(
        'slack',
        raw,
        { 'x-slack-signature': signature, 'x-slack-request-timestamp': timestamp },
        secret,
      ),
    ).toBe(true);
  });

  test('no configured secret allows local intake', () => {
    expect(verifyIntakeSignature('sentry', '{}', {}, null)).toBe(true);
  });
});
