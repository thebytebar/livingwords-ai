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
  if (state?.answer) return 'Typing…';
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
  return !state?.answer;
}
