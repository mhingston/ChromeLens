import type { ActivityEvent } from "../../../packages/domain/src/index.ts";

export interface DeliveryQueueState {
  events: ActivityEvent[];
  droppedCount: number;
  attempts: number;
  nextRetryAt: number;
  lastError: string | null;
}

export function newDeliveryQueue(): DeliveryQueueState {
  return { events: [], droppedCount: 0, attempts: 0, nextRetryAt: 0, lastError: null };
}

export function enqueueForDelivery(
  state: DeliveryQueueState,
  event: ActivityEvent,
  maximumSize = 5_000,
): DeliveryQueueState {
  if (maximumSize < 1) throw new Error("Queue size must be positive");
  if (state.events.some((queued) => queued.eventId === event.eventId)) return state;
  const events = [...state.events, event];
  const overflow = Math.max(0, events.length - maximumSize);
  return {
    ...state,
    events: overflow ? events.slice(overflow) : events,
    droppedCount: state.droppedCount + overflow,
  };
}

export function markDeliveryFailed(
  state: DeliveryQueueState,
  now: number,
  message = "Collector unavailable",
): DeliveryQueueState {
  const attempts = Math.min(state.attempts + 1, 16);
  const delay = Math.min(60_000, 1_000 * (2 ** (attempts - 1)));
  return { ...state, attempts, nextRetryAt: now + delay, lastError: message };
}

export function markDeliverySucceeded(state: DeliveryQueueState, eventIds: string[]): DeliveryQueueState {
  const delivered = new Set(eventIds);
  return {
    ...state,
    events: state.events.filter((event) => !delivered.has(event.eventId)),
    attempts: 0,
    nextRetryAt: 0,
    lastError: null,
  };
}
