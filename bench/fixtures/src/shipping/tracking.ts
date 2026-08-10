// Carrier tracking events.
// Part of the CORTEX benchmark fixture corpus. Not production code.

export interface TrackingEvent {
  at: Date;
  status: string;
  location: string;
}

const events = new Map<string, TrackingEvent[]>();

export function record(labelId: string, event: TrackingEvent): void {
  events.set(labelId, [...(events.get(labelId) ?? []), event]);
}

export function history(labelId: string): TrackingEvent[] {
  return events.get(labelId) ?? [];
}
