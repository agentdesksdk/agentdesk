import { useCallback, useEffect, useRef, useState } from "react";

export type AnnouncerState = {
  text: string;
  queue: readonly string[];
};

export const EMPTY: AnnouncerState = { text: "", queue: [] };

export function enqueue(state: AnnouncerState, text: string): AnnouncerState {
  return { ...state, queue: [...state.queue, text] };
}

/**
 * Returns null when there is nothing left to render.
 *
 * A live region announces on DOM mutation, so writing the same string twice
 * is silent. Clearing first without consuming the queue turns a repeat into
 * two mutations, and draining one entry per call keeps a burst in order.
 */
export function step(state: AnnouncerState): AnnouncerState | null {
  const [head, ...rest] = state.queue;
  if (head === undefined) {
    return null;
  }
  return head === state.text
    ? { text: "", queue: state.queue }
    : { text: head, queue: rest };
}

export function useAnnouncer(clearAfterMs?: number): {
  announcement: string;
  announce: (text: string) => void;
} {
  const [state, setState] = useState<AnnouncerState>(EMPTY);
  const frame = useRef<number | undefined>(undefined);
  const clearTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (state.queue.length === 0) {
      return;
    }
    frame.current = window.requestAnimationFrame(() => {
      setState((current) => step(current) ?? current);
    });
    return () => window.cancelAnimationFrame(frame.current!);
  }, [state]);

  useEffect(() => {
    if (clearAfterMs === undefined || state.text === "" || state.queue.length > 0) {
      return;
    }
    clearTimer.current = window.setTimeout(() => setState(EMPTY), clearAfterMs);
    return () => window.clearTimeout(clearTimer.current);
  }, [state, clearAfterMs]);

  return {
    announcement: state.text,
    announce: useCallback((text: string) => {
      setState((current) => enqueue(current, text));
    }, []),
  };
}
