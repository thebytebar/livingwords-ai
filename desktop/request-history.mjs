const RECENT_HISTORY_MESSAGE_COUNT = 8;

export function selectRequestHistory(messages, { recentOnly = false } = {}) {
  if (!Array.isArray(messages)) throw new TypeError('Conversation messages must be an array.');

  const activeMessages = messages.filter((message) => message.status !== 'cancelled');
  const selectedMessages = recentOnly
    ? activeMessages.slice(-RECENT_HISTORY_MESSAGE_COUNT)
    : activeMessages;
  return selectedMessages.map((message) => {
    if (!message || !['user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string') {
      throw new TypeError('Conversation messages must contain a supported role and text.');
    }
    return { role: message.role, content: message.content };
  });
}

function affirmsSkillInvocation(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (/\b(?:no|nope|not now|don't|do not|cancel|skip|not yet)\b/iu.test(text)) return false;
  return /^(?:yes|yeah|yep|sure|certainly|absolutely|ok|okay|sounds good|that works|please do|please run|go ahead|do it|run (?:it|that|the skill)|proceed)\b/iu
    .test(text);
}

export function pendingSkillId(messages, skillIds = [], currentMessage = '') {
  if (!Array.isArray(messages) || !Array.isArray(skillIds)
    || typeof currentMessage !== 'string') {
    throw new TypeError('Pending skill input is invalid.');
  }
  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role !== 'assistant'
    || lastMessage.status === 'cancelled' || lastMessage.status === 'interrupted') {
    return null;
  }
  const selection = lastMessage.skillSelection ?? lastMessage.workflowSelection;
  const selectedId = selection?.id;
  const skillId = selectedId === 'workflow-builder' ? 'skill-builder' : selectedId;
  if (typeof skillId !== 'string' || !skillIds.includes(skillId)) return null;
  if (selection.requiresConfirmation === true) {
    return affirmsSkillInvocation(currentMessage) ? skillId : null;
  }
  const content = typeof lastMessage.content === 'string' ? lastMessage.content : '';
  const asksForInput = content.includes('?')
    || /\b(?:please (?:provide|share|answer|choose|confirm)|tell me|let me know|you may (?:answer|skip|continue)|reply with|say continue)\b/iu
      .test(content);
  return asksForInput ? skillId : null;
}
