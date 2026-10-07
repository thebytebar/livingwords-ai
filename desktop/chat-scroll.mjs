export function isNearScrollBottom({ scrollHeight, clientHeight, scrollTop }, threshold = 48) {
  return scrollHeight - clientHeight - scrollTop <= threshold;
}

export function preservedScrollTop(scrollTop, scrollHeight, clientHeight) {
  return Math.min(scrollTop, Math.max(0, scrollHeight - clientHeight));
}
