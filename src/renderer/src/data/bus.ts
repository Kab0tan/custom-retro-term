import type { DataTopic, TopicPayloads } from "@shared/data";

/**
 * Panel-side subscriptions. Any number of panels can watch a topic; main is told once
 * (first subscriber in) and released once (last one out). While the page is hidden the
 * subscriptions are paused, so main stops collecting for us.
 */
type Listener = (payload: unknown) => void;

const listeners = new Map<DataTopic, Set<Listener>>();
let hidden = document.visibilityState === "hidden";

window.crt.data.onUpdate((topic, payload) => {
  for (const l of listeners.get(topic) ?? []) l(payload);
});

document.addEventListener("visibilitychange", () => {
  const nowHidden = document.visibilityState === "hidden";
  if (nowHidden === hidden) return;
  hidden = nowHidden;
  for (const topic of listeners.keys()) {
    if (hidden) window.crt.data.unsubscribe(topic);
    else window.crt.data.subscribe(topic);
  }
});

/** Ask main to collect a topic again now (only some topics support it; others ignore it). */
export function refresh(topic: DataTopic): void {
  if (listeners.has(topic) && !hidden) window.crt.data.refresh(topic);
}

export function subscribe<T extends DataTopic>(
  topic: T,
  cb: (payload: TopicPayloads[T]) => void,
): () => void {
  let set = listeners.get(topic);
  if (!set) {
    listeners.set(topic, (set = new Set()));
    if (!hidden) window.crt.data.subscribe(topic);
  }
  const l = cb as Listener;
  set.add(l);
  return () => {
    set!.delete(l);
    if (set!.size) return;
    listeners.delete(topic);
    if (!hidden) window.crt.data.unsubscribe(topic);
  };
}
