import { describe, expect, it } from 'vitest';
import { checkedUrl, isPublicAddress, resolvePublic } from '../../src/fetch/index.js';
import { provenanceUrl } from '../../src/fetch/policy.js';

describe('publisher URL and address policy', () => {
  it.each([
    ['http://publisher.test/file', 'https_required'],
    ['ftp://publisher.test/file', 'https_required'],
    ['https://user:password\u0040publisher.test/file', 'embedded_credentials'],
    ['https://publisher.test:444/file', 'blocked_port'],
    ['https://other.test/file', 'host_not_allowed'],
    ['https://publisher.test.evil.test/file', 'host_not_allowed'],
    ['not a URL', 'invalid_url'],
    ['https://2130706433/file', 'blocked_address'],
    ['https://0x7f000001/file', 'blocked_address'],
    ['https://[::ffff:127.0.0.1]/file', 'blocked_address'],
  ])('rejects %s as %s', (url, code) => {
    expect(() => checkedUrl(url, ['publisher.test'])).toThrow(expect.objectContaining({ code }));
  });

  it('accepts explicit 443, folds case, strips fragments and requires exact hosts', () => {
    expect(checkedUrl('https://PUBLISHER.test:443/file#fragment', ['publisher.test']).href).toBe('https://publisher.test/file');
  });

  it.each([
    '0.0.0.0', '0.4.5.6', '10.0.0.5', '100.64.0.1', '100.100.100.200', '127.0.0.1',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.0.1', '224.0.0.1', '239.1.2.3',
    '255.255.255.255', '198.18.0.1', '192.0.2.1', '203.0.113.1',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.5', '::ffff:169.254.169.254',
    'fc00::1', 'fd00:ec2::254', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', '64:ff9b::7f00:1',
    '2001::1', '3fff::1', 'fe80::1%lo0', 'nonsense',
  ])('blocks special-use address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'])('accepts public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it('rejects a mixed public/private DNS answer instead of picking the public address', async () => {
    await expect(resolvePublic(new URL('https://publisher.test'), async () => [
      { address: '8.8.8.8', family: 4 }, { address: '10.0.0.5', family: 4 },
    ], 100)).rejects.toMatchObject({ code: 'blocked_address' });
  });

  it('bounds DNS time and types DNS failures and empty answers', async () => {
    const url = new URL('https://publisher.test');
    await expect(resolvePublic(url, () => new Promise(() => {}), 10)).rejects.toMatchObject({ code: 'connect_timeout' });
    await expect(resolvePublic(url, async () => { throw new Error('sensitive detail'); }, 100)).rejects.toMatchObject({ code: 'dns_error' });
    await expect(resolvePublic(url, async () => [], 100)).rejects.toMatchObject({ code: 'dns_error' });
  });

  it('redacts all query values, including unrecognised secret parameters', () => {
    const redacted = provenanceUrl(new URL('https://publisher.test/file?api_key=synthetic-secret&custom=also-secret&custom=again#x'));
    expect(redacted).not.toContain('synthetic-secret');
    expect(redacted).not.toContain('also-secret');
    expect(new URL(redacted).searchParams.get('custom')).toBe('[REDACTED]');
  });
});
