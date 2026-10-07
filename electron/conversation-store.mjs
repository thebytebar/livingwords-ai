import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_SESSIONS = 10_000;
const MAX_MESSAGES_PER_SESSION = 10_000;
const MAX_MESSAGE_LENGTH = 24_000;
const MAX_SESSION_CONTENT = 8_000_000;
const MAX_TITLE_LENGTH = 120;
const MAX_SELECTED_DOCUMENTS = 100;
const MAX_RETRIEVED_DOCUMENTS = 10_000;
const MAX_SOURCES_PER_MESSAGE = 100;
const MAX_SOURCE_EXCERPT_LENGTH = 12_000;
const MAX_CONTEXT_USAGE_PER_MESSAGE = 100;
const MAX_CONTEXT_USAGE_EXCERPT_LENGTH = 1_600;
const DOCUMENT_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const CONTEXT_USAGE_METHODS = new Set([
  'attached-document',
  'document-search',
  'document-read',
  'folder-instructions',
  'folder-read',
  'folder-grep',
]);

function validateSources(message) {
  if (message.sources === undefined) return undefined;
  if (message.role !== 'assistant' || !Array.isArray(message.sources)
    || message.sources.length > MAX_SOURCES_PER_MESSAGE) {
    throw new Error('Conversation contains invalid document citations.');
  }
  const citationIds = new Set();
  return message.sources.map((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || typeof source.citationId !== 'string' || !/^S\d{1,3}$/u.test(source.citationId)
      || citationIds.has(source.citationId)
      || typeof source.documentId !== 'string' || !DOCUMENT_ID_PATTERN.test(source.documentId)
      || typeof source.name !== 'string' || !source.name || source.name.length > 1_024
      || (source.page !== null && (!Number.isSafeInteger(source.page) || source.page < 1))
      || typeof source.excerpt !== 'string' || !source.excerpt
      || source.excerpt.length > MAX_SOURCE_EXCERPT_LENGTH) {
      throw new Error('Conversation contains an invalid document citation.');
    }
    citationIds.add(source.citationId);
    return {
      citationId: source.citationId,
      documentId: source.documentId,
      name: source.name,
      page: source.page,
      excerpt: source.excerpt,
    };
  });
}

function validateContextUsage(message) {
  if (message.contextUsage === undefined) return undefined;
  if (message.role !== 'assistant' || !Array.isArray(message.contextUsage)
    || message.contextUsage.length > MAX_CONTEXT_USAGE_PER_MESSAGE) {
    throw new Error('Conversation contains invalid document context provenance.');
  }
  return message.contextUsage.map((usage) => {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)
      || typeof usage.documentId !== 'string' || !DOCUMENT_ID_PATTERN.test(usage.documentId)
      || typeof usage.name !== 'string' || !usage.name || usage.name.length > 1_024
      || !CONTEXT_USAGE_METHODS.has(usage.method)
      || (usage.page !== null && (!Number.isSafeInteger(usage.page) || usage.page < 1))
      || (usage.startLine !== undefined && (!Number.isSafeInteger(usage.startLine) || usage.startLine < 1))
      || (usage.endLine !== undefined && (!Number.isSafeInteger(usage.endLine) || usage.endLine < 1))
      || ((usage.startLine === undefined) !== (usage.endLine === undefined))
      || (usage.startLine !== undefined && usage.endLine < usage.startLine)
      || typeof usage.excerpt !== 'string' || !usage.excerpt
      || usage.excerpt.length > MAX_CONTEXT_USAGE_EXCERPT_LENGTH
      || typeof usage.truncated !== 'boolean') {
      throw new Error('Conversation contains invalid document context provenance.');
    }
    return {
      documentId: usage.documentId,
      name: usage.name,
      method: usage.method,
      page: usage.page,
      ...(usage.startLine !== undefined ? { startLine: usage.startLine, endLine: usage.endLine } : {}),
      excerpt: usage.excerpt,
      truncated: usage.truncated,
    };
  });
}

function validateSession(session) {
  if (!session || typeof session !== 'object'
    || typeof session.id !== 'string' || !session.id
    || typeof session.title !== 'string' || session.title.length > MAX_TITLE_LENGTH
    || typeof session.createdAt !== 'string' || !Number.isFinite(Date.parse(session.createdAt))
    || typeof session.updatedAt !== 'string' || !Number.isFinite(Date.parse(session.updatedAt))
    || !Array.isArray(session.messages) || session.messages.length > MAX_MESSAGES_PER_SESSION) {
    throw new Error('Conversation data is invalid.');
  }

  if (session.selectedDocumentIds !== undefined
    && (!Array.isArray(session.selectedDocumentIds)
      || session.selectedDocumentIds.length > MAX_SELECTED_DOCUMENTS
      || session.selectedDocumentIds.some((id) => typeof id !== 'string' || !DOCUMENT_ID_PATTERN.test(id))
      || new Set(session.selectedDocumentIds).size !== session.selectedDocumentIds.length)) {
    throw new Error('Conversation has invalid selected documents.');
  }
  if (session.retrievedDocumentIds !== undefined
    && (!Array.isArray(session.retrievedDocumentIds)
      || session.retrievedDocumentIds.length > MAX_RETRIEVED_DOCUMENTS
      || session.retrievedDocumentIds.some((id) => typeof id !== 'string' || !DOCUMENT_ID_PATTERN.test(id))
      || new Set(session.retrievedDocumentIds).size !== session.retrievedDocumentIds.length)) {
    throw new Error('Conversation has invalid retrieved documents.');
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
    const sources = validateSources(message);
    const contextUsage = validateContextUsage(message);
    if (sources) {
      contentLength += sources.reduce((total, source) => total + source.excerpt.length, 0);
    }
    if (contextUsage) {
      contentLength += contextUsage.reduce((total, usage) => total + usage.excerpt.length, 0);
    }
    if (contentLength > MAX_SESSION_CONTENT) throw new Error('Conversation exceeds the local storage limit.');
    return {
      role: message.role,
      content: message.content,
      ...(message.status !== undefined ? { status: message.status } : {}),
      ...(sources !== undefined ? { sources } : {}),
      ...(contextUsage !== undefined ? { contextUsage } : {}),
    };
  });

  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    selectedDocumentIds: [...(session.selectedDocumentIds ?? [])],
    retrievedDocumentIds: [...(session.retrievedDocumentIds ?? [])],
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
    async get(id) {
      if (typeof id !== 'string' || !id) throw new Error('Conversation ID is invalid.');
      const sessions = await readSessions();
      const session = sessions.find((item) => item.id === id);
      if (!session) throw new Error('Conversation does not exist.');
      return session;
    },
    async create() {
      const sessions = await readSessions();
      const now = new Date().toISOString();
      const session = {
        id: randomUUID(),
        title: 'New conversation',
        createdAt: now,
        updatedAt: now,
        selectedDocumentIds: [],
        retrievedDocumentIds: [],
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
    async removeDocumentSelection(documentId, sessionId, retainedFileIds) {
      if (typeof documentId !== 'string' || !DOCUMENT_ID_PATTERN.test(documentId)) {
        throw new Error('Document ID is invalid.');
      }
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId)) {
        throw new Error('Conversation ID is invalid.');
      }
      if (retainedFileIds !== undefined
        && (!Array.isArray(retainedFileIds)
          || retainedFileIds.length > MAX_RETRIEVED_DOCUMENTS
          || retainedFileIds.some((id) => typeof id !== 'string' || !DOCUMENT_ID_PATTERN.test(id)))) {
        throw new Error('Retained document IDs are invalid.');
      }
      const retained = retainedFileIds === undefined ? null : new Set(retainedFileIds);
      const sessions = await readSessions();
      let changed = false;
      const updated = sessions.map((session) => {
        if (sessionId !== undefined && session.id !== sessionId) return session;
        const selectedDocumentIds = session.selectedDocumentIds.filter((id) => id !== documentId);
        const retrievedDocumentIds = retained
          ? session.retrievedDocumentIds.filter((id) => retained.has(id))
          : session.retrievedDocumentIds;
        let messagesChanged = false;
        const messages = retained
          ? session.messages.map((message) => {
            if (message.role !== 'assistant') return message;
            const removedCitationIds = new Set();
            const sources = Array.isArray(message.sources)
              ? message.sources.filter((source) => {
                  if (retained.has(source.documentId)) return true;
                  removedCitationIds.add(source.citationId);
                  return false;
                })
              : undefined;
            const contextUsage = Array.isArray(message.contextUsage)
              ? message.contextUsage.filter((usage) => retained.has(usage.documentId))
              : undefined;
            if (removedCitationIds.size === 0
              && (!contextUsage || contextUsage.length === message.contextUsage.length)) return message;
            messagesChanged = true;
            const content = removedCitationIds.size > 0
              ? message.content.replace(/\[S\d{1,3}\]/gu, (marker) =>
                removedCitationIds.has(marker.slice(1, -1)) ? '' : marker)
                .replace(/[ \t]{2,}/gu, ' ')
                .replace(/ +([,.;!?])/gu, '$1')
              : message.content;
            return {
              ...message,
              content,
              ...(sources !== undefined
                ? (sources.length > 0 ? { sources } : { sources: undefined })
                : {}),
              ...(contextUsage !== undefined ? { contextUsage } : {}),
            };
          })
          : session.messages;
        if (selectedDocumentIds.length === session.selectedDocumentIds.length
          && retrievedDocumentIds.length === session.retrievedDocumentIds.length
          && !messagesChanged) return session;
        changed = true;
        return {
          ...session,
          updatedAt: new Date().toISOString(),
          selectedDocumentIds,
          retrievedDocumentIds,
          messages,
        };
      });
      if (changed) await writeSessions(updated);
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
