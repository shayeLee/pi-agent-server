import { useLayoutEffect, useRef } from 'react';

/** Follow growing output without interrupting someone reading earlier entries. */
export function useFollowBottom(resetKey: string, content: unknown, enabled = true, navigation?: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const identity = useRef(resetKey);
  const lastNavigation = useRef<unknown>(undefined);
  const metrics = useRef({ top: 0, height: 0, viewport: 0 });
  const remember = (el: HTMLElement) => {
    metrics.current = { top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight };
  };
  const pause = () => { follow.current = false; };
  useLayoutEffect(() => {
    if (identity.current !== resetKey) {
      identity.current = resetKey;
      follow.current = true;
    }
    if (navigation && navigation !== lastNavigation.current) pause();
    lastNavigation.current = navigation;
    const el = ref.current;
    if (!el) return;
    if (enabled && follow.current) el.scrollTop = el.scrollHeight;
    remember(el);
  }, [resetKey, content, enabled, navigation]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (follow.current) el.scrollTop = el.scrollHeight;
      remember(el);
    });
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [resetKey, enabled]);
  return {
    ref,
    onScroll: () => {
      const el = ref.current;
      if (!el) return;
      const previous = metrics.current;
      if (el.scrollHeight - el.clientHeight - el.scrollTop <= 48) follow.current = true;
      else if (el.scrollTop < previous.top && el.scrollHeight === previous.height && el.clientHeight === previous.viewport) pause();
      remember(el);
    },
    pause,
  };
}
