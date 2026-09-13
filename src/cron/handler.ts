import { getSandbox } from '@cloudflare/sandbox';
import type { OpenClawEnv } from '../types';
import { buildSandboxOptions } from '../index';
import { prepareGateway } from '../gateway';
import { shouldWakeContainer, DEFAULT_LEAD_TIME_MS, CRON_STORE_R2_KEY } from './wake';

/**
 * Wake the container if OpenClaw has upcoming cron jobs.
 * Missing cron store or no imminent job is a no-op and must not block snapshots.
 */
export async function maybeWakeForOpenClawJobs(env: OpenClawEnv): Promise<void> {
  const cronStoreObject = await env.BACKUP_BUCKET.get(CRON_STORE_R2_KEY);
  if (!cronStoreObject) {
    console.log('[CRON] No cron store found in R2, skipping wake');
    return;
  }

  const cronStoreJson = await cronStoreObject.text();
  const leadMinutes = parseInt(env.CRON_WAKE_AHEAD_MINUTES || '', 10);
  const leadTimeMs = leadMinutes > 0 ? leadMinutes * 60_000 : DEFAULT_LEAD_TIME_MS;
  const nowMs = Date.now();

  const earliestRun = shouldWakeContainer(cronStoreJson, nowMs, leadTimeMs);
  if (!earliestRun) {
    console.log('[CRON] No upcoming cron jobs within lead time, skipping wake');
    return;
  }

  const deltaMinutes = ((earliestRun - nowMs) / 60_000).toFixed(1);
  console.log(`[CRON] Cron job due in ${deltaMinutes}m, waking container`);

  const sandbox = getSandbox(env.Sandbox, 'openclaw', buildSandboxOptions(env));
  await prepareGateway(sandbox, env);
  console.log('[CRON] Container woken successfully');
}

/**
 * Optional scheduled OpenClaw job wake. Backups are session-scoped and happen
 * from the Sandbox activity-expiry hook, never from this path.
 */
export async function handleScheduled(env: OpenClawEnv): Promise<void> {
  try {
    await maybeWakeForOpenClawJobs(env);
  } catch (error) {
    console.warn('[CRON] OpenClaw wake failed', error);
  }
}
