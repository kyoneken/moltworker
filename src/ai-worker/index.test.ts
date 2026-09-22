import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL } from '../ai-proxy/constants';
import { aiWorkerApp } from './index';

function createAiEnv(overrides: Record<string, unknown> = {}): {
  AI: Ai;
  AI_PROXY_TOKEN?: string;
  AI_GATEWAY_ID?: string;
} {
  return {
    AI: {
      run: vi.fn(),
    } as unknown as Ai,
    AI_PROXY_TOKEN: 'proxy-secret',
    AI_GATEWAY_ID: 'moltworker',
    ...overrides,
  };
}

describe('aiWorkerApp', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns health without requiring secrets', async () => {
    const response = await aiWorkerApp.request('/health', { method: 'GET' }, createAiEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'moltworker-ai',
      aiBound: true,
    });
  });

  it('rejects unauthorized chat completions on the /v1 alias', async () => {
    const response = await aiWorkerApp.request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
      createAiEnv(),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_api_key', type: 'authentication_error' },
    });
  });

  it('rejects chat completions when AI_PROXY_TOKEN is unset (fail-closed)', async () => {
    const response = await aiWorkerApp.request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer anything',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
      createAiEnv({ AI_PROXY_TOKEN: undefined }),
    );

    expect(response.status).toBe(401);
  });

  it('requires an allowlisted model when BACKUP_BUCKET is absent', async () => {
    const response = await aiWorkerApp.request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer proxy-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
      createAiEnv(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'model_not_allowed' },
    });
  });
});
