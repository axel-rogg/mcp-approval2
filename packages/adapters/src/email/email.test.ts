/**
 * Tests fuer EmailAdapter — Console + Resend.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConsoleEmailAdapter } from './console.js';
import { ResendEmailAdapter } from './resend.js';
import { EmailSendError, type EmailMessage } from './interface.js';

const stubMsg: EmailMessage = {
  to: 'bob@example.test',
  subject: 'Invite to mcp-approval2',
  html: '<p>Click <a href="https://mcp2/x">here</a></p>',
  text: 'Click https://mcp2/x',
};

describe('ConsoleEmailAdapter', () => {
  it('returns pseudo-id + captures when capture array provided', async () => {
    const capture: EmailMessage[] = [];
    const adapter = new ConsoleEmailAdapter({ capture, silent: true });
    const r = await adapter.send(stubMsg);
    expect(r.provider).toBe('console');
    expect(r.id).toMatch(/^console-/);
    expect(capture).toHaveLength(1);
    expect(capture[0]).toEqual(stubMsg);
  });

  it('does NOT log body in console (only to/subject/id)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const adapter = new ConsoleEmailAdapter();
    await adapter.send(stubMsg);
    const logCall = logSpy.mock.calls[0]?.[0] as string | undefined;
    expect(logCall).toContain('to=bob@example.test');
    expect(logCall).toContain('subject="Invite to mcp-approval2"');
    expect(logCall).not.toContain(stubMsg.html);
    expect(logCall).not.toContain('Click here');
    logSpy.mockRestore();
  });
});

describe('ResendEmailAdapter', () => {
  function makeFetchStub(response: {
    status: number;
    body: string | Record<string, unknown>;
  }): typeof fetch {
    return vi.fn().mockResolvedValue(
      new Response(typeof response.body === 'string' ? response.body : JSON.stringify(response.body), {
        status: response.status,
      }),
    ) as unknown as typeof fetch;
  }

  it('wirft wenn apiKey leer', () => {
    expect(() => new ResendEmailAdapter({ apiKey: '', from: 'a@b.test' })).toThrow();
  });

  it('wirft wenn from leer', () => {
    expect(() => new ResendEmailAdapter({ apiKey: 'k', from: '' })).toThrow();
  });

  it('happy path: POST /emails + returnt provider-id', async () => {
    const fetchStub = makeFetchStub({ status: 200, body: { id: 'r-12345' } });
    const adapter = new ResendEmailAdapter({
      apiKey: 'rs_test',
      from: 'mcp-approval2 <noreply@mcp.test>',
      fetchImpl: fetchStub,
    });
    const r = await adapter.send(stubMsg);
    expect(r).toEqual({ id: 'r-12345', provider: 'resend' });
    expect(fetchStub).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer rs_test',
          'content-type': 'application/json',
        }),
      }),
    );
  });

  it('wirft EmailSendError bei 422 mit Detail', async () => {
    const fetchStub = makeFetchStub({
      status: 422,
      body: { name: 'validation_error', message: 'Invalid `to` field' },
    });
    const adapter = new ResendEmailAdapter({
      apiKey: 'rs_test',
      from: 'noreply@mcp.test',
      fetchImpl: fetchStub,
    });
    await expect(adapter.send(stubMsg)).rejects.toBeInstanceOf(EmailSendError);
  });

  it('wirft EmailSendError bei Netzwerk-Fail', async () => {
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;
    const adapter = new ResendEmailAdapter({
      apiKey: 'rs_test',
      from: 'noreply@mcp.test',
      fetchImpl: fetchStub,
    });
    await expect(adapter.send(stubMsg)).rejects.toMatchObject({
      name: 'EmailSendError',
      provider: 'resend',
      status: null,
    });
  });

  it('replyTo wird im Body uebermittelt wenn gesetzt', async () => {
    const fetchStub = makeFetchStub({ status: 200, body: { id: 'r-2' } });
    const adapter = new ResendEmailAdapter({
      apiKey: 'k',
      from: 'noreply@mcp.test',
      fetchImpl: fetchStub,
    });
    await adapter.send({ ...stubMsg, replyTo: 'admin@mcp.test' });
    const call = (fetchStub as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['reply_to']).toBe('admin@mcp.test');
  });
});
