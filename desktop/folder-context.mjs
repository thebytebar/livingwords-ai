export function usedFolderDocuments(files, documentIds) {
  if (!Array.isArray(files) || !(documentIds instanceof Set)) {
    throw new TypeError('Folder files and context document IDs are required.');
  }
  return files.filter((file) => documentIds.has(file.id));
}

export function contextUsageForDocument(messages, documentId) {
  if (!Array.isArray(messages) || typeof documentId !== 'string') {
    throw new TypeError('Conversation messages and a document ID are required.');
  }
  return messages.flatMap((message) => {
    if (message?.role !== 'assistant') return [];
    const usage = Array.isArray(message.contextUsage)
      ? message.contextUsage.filter((record) => record?.documentId === documentId)
      : [];
    const citations = usage.length === 0 && Array.isArray(message.sources)
      ? message.sources.filter((source) => source?.documentId === documentId).map((source) => ({
          documentId: source.documentId,
          name: source.name,
          method: 'citation',
          page: source.page,
          excerpt: source.excerpt,
          truncated: false,
        }))
      : [];
    return [...usage, ...citations];
  });
}

export function flatContextFileName(path) {
  if (typeof path !== 'string' || !path) throw new TypeError('A context file path is required.');
  const name = path.split(/[\\/]/u).filter(Boolean).at(-1);
  if (!name || name === '.' || name === '..') throw new TypeError('The context file path is invalid.');
  return name;
}

export function documentContextCounts(files, selectedReferenceIds, contextDocumentIds) {
  if (!Array.isArray(files) || !Array.isArray(selectedReferenceIds)
    || !(contextDocumentIds instanceof Set)) {
    throw new TypeError('Attached files, references, and context document IDs are required.');
  }
  const selectedReferences = new Set(selectedReferenceIds);
  const availableIds = new Set();
  for (const file of files) {
    if (!file || typeof file.id !== 'string' || !Array.isArray(file.referenceIds)) {
      throw new TypeError('Attached document metadata is invalid.');
    }
    if (file.referenceIds.some((referenceId) => selectedReferences.has(referenceId))) {
      availableIds.add(file.id);
    }
  }
  const total = availableIds.size;
  const used = [...availableIds].filter((documentId) => contextDocumentIds.has(documentId)).length;
  return { used, total };
}

export function folderCanExpand(files) {
  if (!Array.isArray(files)) throw new TypeError('Folder context files are required.');
  return files.length > 0;
}

export function mergeRetrievedDocumentIds(session, documentIds) {
  if (!session || !Array.isArray(documentIds)
    || (session.retrievedDocumentIds !== undefined && !Array.isArray(session.retrievedDocumentIds))) {
    throw new TypeError('A conversation and retrieved document IDs are required.');
  }
  const previous = session.retrievedDocumentIds ?? [];
  const merged = [...new Set([...previous, ...documentIds])];
  session.retrievedDocumentIds = merged;
  return merged.length !== previous.length;
}
