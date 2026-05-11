import { PostHog } from 'posthog-node';

interface WorkerPayload {
  apiKey: string;
  host: string;
  distinctId: string;
  events: Array<{ event: string; properties: Record<string, unknown> }>;
}

async function main(): Promise<void> {
  const raw = process.env.DOKKIMI_TELEMETRY_PAYLOAD;
  if (!raw) {
    return;
  }

  let payload: WorkerPayload;
  try {
    payload = JSON.parse(raw) as WorkerPayload;
  } catch {
    return;
  }

  if (!payload.events || payload.events.length === 0) {
    return;
  }

  const client = new PostHog(payload.apiKey, {
    host: payload.host,
    disableGeoip: true,
  });

  for (const ev of payload.events) {
    client.capture({
      distinctId: payload.distinctId,
      event: ev.event,
      properties: ev.properties,
    });
  }

  await client.shutdown();
}

main().catch(() => {
  // Never fail a detached flush
});
