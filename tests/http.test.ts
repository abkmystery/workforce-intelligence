import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/auth', () => ({ getActor: vi.fn(), assertSameOrigin: vi.fn() }));
vi.mock('../src/lib/db', () => ({ transaction: vi.fn() }));
import { jsonBody } from '../src/lib/http';

function request(body: string, headers: Record<string, string> = {}) {
 return new Request('https://workforce.test/api/team-needs', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
 });
}

describe('bounded JSON requests', () => {
 it('accepts JSON with a charset and a body exactly at the byte limit', async () => {
  const value = 'a'.repeat(127998);
  await expect(jsonBody(request(JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' }))).resolves.toBe(value);
 });

 it('rejects oversized declared bodies before reading them', async () => {
  const input = request('{}', { 'Content-Length': '128001' });
  const read = vi.spyOn(input.body!, 'getReader');
  await expect(jsonBody(input)).rejects.toMatchObject({ status: 413, code: 'REQUEST_TOO_LARGE' });
  expect(read).not.toHaveBeenCalled();
 });

 it('counts UTF-8 bytes even when Content-Length understates the body', async () => {
  await expect(jsonBody(request(JSON.stringify('é'.repeat(64000)), { 'Content-Length': '2' })))
   .rejects.toMatchObject({ status: 413 });
 });

 it('cancels a chunked stream as soon as it exceeds the byte limit', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
   start(controller) {
    controller.enqueue(new Uint8Array(64000));
    controller.enqueue(new Uint8Array(64001));
   }, cancel,
  });
  const input = new Request('https://workforce.test/api/team-needs', {
   method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half',
  } as RequestInit);
  await expect(jsonBody(input)).rejects.toMatchObject({ status: 413 });
  expect(cancel).toHaveBeenCalledOnce();
 });

 it('rejects malformed JSON and misleading content types', async () => {
  await expect(jsonBody(request('{'))).rejects.toMatchObject({ status: 400, code: 'INVALID_JSON' });
  await expect(jsonBody(request('{}', { 'Content-Type': 'text/plain; application/json' })))
   .rejects.toMatchObject({ status: 415, code: 'JSON_REQUIRED' });
 });
});
