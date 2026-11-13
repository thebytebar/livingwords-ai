function activeToken(value, selectionStart, selectionEnd, prefix) {
  if (typeof value !== 'string' || !Number.isInteger(selectionStart)
    || selectionStart !== selectionEnd || selectionStart < 0 || selectionStart > value.length) {
    return null;
  }
  const before = value.slice(0, selectionStart);
  const match = new RegExp(`(^|\\s)${prefix}([a-zA-Z0-9_-]*)$`, 'u').exec(before);
  if (!match) return null;
  const start = selectionStart - match[0].length + match[1].length;
  const after = value.slice(selectionStart);
  const following = /^[a-zA-Z0-9_-]*/u.exec(after)[0];
  return {
    start,
    end: selectionStart + following.length,
    query: `${match[2]}${following}`,
  };
}

export function activeToolMention(value, selectionStart, selectionEnd = selectionStart) {
  return activeToken(value, selectionStart, selectionEnd, '@');
}

export function activeSkillCommand(value, selectionStart, selectionEnd = selectionStart) {
  if (typeof value !== 'string' || !Number.isInteger(selectionStart)
    || selectionStart !== selectionEnd || selectionStart < 0 || selectionStart > value.length) {
    return null;
  }
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
  const before = value.slice(lineStart, selectionStart);
  const slash = before.lastIndexOf('/');
  if (slash < 0 || (slash > 0 && !/\s/u.test(before[slash - 1]))) return null;
  const start = lineStart + slash;
  const lineEnd = value.indexOf('\n', selectionStart);
  const end = lineEnd < 0 ? value.length : lineEnd;
  return {
    start,
    end,
    query: value.slice(start + 1, end),
  };
}

export function filterToolCatalog(tools, query) {
  const normalizedQuery = String(query ?? '').trim().toLocaleLowerCase();
  return tools.filter((tool) => [
    tool.name,
    tool.summary,
    tool.availability,
  ].some((value) => String(value ?? '').toLocaleLowerCase().includes(normalizedQuery)));
}

export function filterSkillCatalog(skills, query) {
  const normalizedQuery = String(query ?? '').trim().toLocaleLowerCase();
  return skills.filter((skill) => [
    skill.name,
    skill.description,
    skill.prompt,
    skill.source === 'builtin' ? 'built-in' : 'custom',
  ].some((value) => String(value ?? '').toLocaleLowerCase().includes(normalizedQuery)));
}

export function standaloneActionPrompt(skillName, toolNames) {
  const tools = [...new Set(toolNames)];
  const action = skillName
    ? `Run the “${skillName}” skill`
    : `Call the selected tool${tools.length === 1 ? '' : 's'}`;
  const toolInstruction = tools.length > 0
    ? ` Use ${tools.map((name) => `@${name}`).join(', ')} with arguments from the conversation.`
    : '';
  return `${action} using the most recent user request in this conversation as the task.${toolInstruction} If there is no request or required information, ask the user instead of inventing it.`;
}
