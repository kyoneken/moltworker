/**
 * Minimal bindings for the OpenAI-compatible Workers AI proxy.
 *
 * Used by both the colocated sandbox route and the standalone Free AI Worker.
 * BACKUP_BUCKET is optional: when absent, chat requests must include an
 * allowlisted `model` (no Admin session-model fallback).
 */
export interface AiProxyBindings {
  AI: Ai;
  AI_PROXY_TOKEN?: string;
  AI_GATEWAY_ID?: string;
  BACKUP_BUCKET?: R2Bucket;
}

export type AiProxyAppEnv = {
  Bindings: AiProxyBindings;
};
