import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_SESSIONS = 10_000;
const MAX_MESSAGES_PER_SESSION = 10_000;
const MAX_MESSAGE_LENGTH = 24_000;
const MAX_SESSION_CONTENT = 8_000_000;
const MAX_TITLE_LENGTH = 120;

function validateSession(session) {
  if (!session || typeof session !== 'object'
    || typeof session.id !== 'string' || !session.id
    || typeof session.title !== 'string' || session.title.length > MAX_TITLE_LENGTH
    || typeof session.createdAt !== 'string' || !Number.isFinite(Date.parse(session.createdAt))
    || typeof session.updatedAt !== 'string' || !Number.isFinite(Date.parse(session.updatedAt))
    || !Array.isArray(session.messages) || session.messages.length > MAX_MESSAGES_PER_SESSION) {
    throw new Error('Conversation data is invalid.');
  }

  let contentLength = 0;
  const messages = session.messages.map((message) => {
    if (!message || typeof message !== 'object'
      || !['user', 'assistant'].includes(message.role)
      || (message.status !== undefined
        && (message.role !== 'assistant'
          || !['cancelled', 'truncated', 'interrupted'].includes(message.status)))
      || typeof message.content !== 'string'
      || message.content.length > MAX_MESSAGE_LENGTH) {
      throw new Error('Conversation contains an invalid message.');
    }
    contentLength += message.content.length;
    if (contentLength > MAX_SESSION_CONTENT) throw new Error('Conversation exceeds the local storage limit.');
    return {
      role: message.role,
      content: message.content,
      ...(message.status !== undefined ? { status: message.status } : {}),
    };
  });

  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages,
  };
}

function validateSessions(value) {
  if (!Array.isArray(value) || value.length > MAX_SESSIONS) {
    throw new Error('The saved conversation list is invalid.');
  }
  const sessions = value.map(validateSession);
  const ids = new Set(sessions.map(({ id }) => id));
  if (ids.size !== sessions.length) throw new Error('The saved conversation list contains duplicate IDs.');
  return sessions;
}

export function createConversationStore(filePath) {
  async function readSessions() {
    let contents;
    try {
      contents = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw new Error(`Could not read local conversations: ${error.message}`, { cause: error });
    }

    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error('The saved conversation file is not valid JSON.', { cause: error });
    }
    return validateSessions(parsed);
  }

  async function writeSessions(sessions) {
    const validatedSessions = validateSessions(sessions);
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(validatedSessions)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    } catch (error) {
      throw new Error(`Could not save local conversations: ${error.message}`, { cause: error });
    }
  }

  return Object.freeze({
    list: readSessions,
    async create() {
      const sessions = await readSessions();
      const now = new Date().toISOString();
      const session = {
        id: randomUUID(),
        title: 'New conversation',
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      sessions.unshift(session);
      await writeSessions(sessions);
      return session;
    },
    async save(input) {
      const session = validateSession(input);
      const sessions = await readSessions();
      const index = sessions.findIndex((item) => item.id === session.id);
      if (index < 0) throw new Error('Cannot save a conversation that does not exist.');
      sessions[index] = session;
      await writeSessions(sessions);
      return session;
    },
    async appendMessage(id, message) {
      if (typeof id !== 'string' || !id) throw new Error('Conversation ID is invalid.');
      const sessions = await readSessions();
      const index = sessions.findIndex((session) => session.id === id);
      if (index < 0) throw new Error('Cannot update a conversation that does not exist.');
      const updated = validateSession({
        ...sessions[index],
        updatedAt: new Date().toISOString(),
        messages: [...sessions[index].messages, message],
      });
      sessions[index] = updated;
      await writeSessions(sessions);
      return updated;
    },
    async delete(id) {
      if (typeof id !== 'string' || !id) throw new Error('Conversation ID is invalid.');
      const sessions = await readSessions();
      const remaining = sessions.filter((session) => session.id !== id);
      if (remaining.length === sessions.length) throw new Error('Cannot delete a conversation that does not exist.');
      await writeSessions(remaining);
    },
  });
}
