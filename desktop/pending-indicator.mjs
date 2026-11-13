export function pendingIndicatorText(status, queuePosition) {
  if (status === 'queued') {
    return queuePosition
      ? `Waiting in queue · position ${queuePosition}`
      : 'Waiting in queue';
  }
  if (status === 'cancelling') return 'Cancelling response…';
  if (status === 'awaiting-command-approval') return 'Waiting for terminal command approval…';
  return null;
}

export function sessionRequestPreviewText(state) {
  if (['completed', 'failed', 'cancelled', 'finishing'].includes(state?.status)) {
    return 'Finishing response…';
  }
  if (state?.status === 'queued') {
    return state.queuePosition
      ? `Queued · ${state.queuePosition}`
      : 'Queued';
  }
  if (state?.status === 'cancelling') return 'Cancelling…';
  if (state?.status === 'saving' || state?.status === 'submitting') return 'Submitting…';
  if (state?.status === 'awaiting-command-approval') return 'Awaiting approval…';
  return 'Thinking…';
}

export function shouldShowTypingAnimation(state) {
  return !['completed', 'failed', 'cancelled'].includes(state?.status);
}

export function formatElapsedTime(elapsedMs) {
  const totalSeconds = Math.floor(Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1_000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  if (hours > 0) return `${hours} hr ${minutes} min ${seconds} sec`;
  if (minutes > 0) return `${minutes} min ${seconds} sec`;
  return `${totalSeconds} sec`;
}
