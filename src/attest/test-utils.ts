import type { AttestEnv } from './types';

interface MemoryEntry {
  value: string;
  expiresAt?: number;
}

export function createMemoryKV(): KVNamespace {
  const store = new Map<string, MemoryEntry>();

  function alive(key: string): MemoryEntry | null {
    const entry = store.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt && Date.now() >= entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  return {
    get: (async (key: string, typeOrOptions?: string | { type?: string }) => {
      const entry = alive(key);
      if (!entry) {
        return null;
      }
      const type = typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions?.type;
      if (type === 'json') {
        return JSON.parse(entry.value) as unknown;
      }
      return entry.value;
    }) as KVNamespace['get'],
    put: async (
      key: string,
      value: string | ArrayBuffer | ArrayBufferView,
      options?: KVNamespacePutOptions,
    ) => {
      const text =
        typeof value === 'string' ? value : new TextDecoder().decode(value as ArrayBuffer);
      const expiresAt = options?.expirationTtl
        ? Date.now() + options.expirationTtl * 1000
        : undefined;
      store.set(key, { value: text, expiresAt });
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({
      keys: [...store.keys()].map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
    getWithMetadata: (async () => ({
      value: null,
      metadata: null,
      cacheStatus: null,
    })) as unknown as KVNamespace['getWithMetadata'],
  } as unknown as KVNamespace;
}

export function createAttestEnv(overrides: Partial<AttestEnv> = {}): AttestEnv {
  return {
    ATTEST_KV: createMemoryKV(),
    APP_ATTEST_APP_ID: 'CYGQ9U7DD2.com.kentymyty.moltworker.mobile.pilot',
    ATTEST_SESSION_SECRET: 'test-attest-session-secret-32bytes-min',
    ATTEST_COOKIE_DOMAIN: '',
    DEV_MODE: 'true',
    CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    ...overrides,
  };
}
