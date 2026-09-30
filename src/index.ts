export {
  answerQuestion,
  applyCitations,
  buildIndex,
  chunkText,
  GENERAL_ANSWER_NOTICE,
  readIndex,
  readIndexIfPresent,
  retrieve,
  UNGROUNDED_NOTICE,
  writeIndex,
  UNSUPPORTED_ANSWER,
} from './core/rag.js';
export type { GroundedAnswer, Passage, RagIndex, SourceCitation } from './core/rag.js';
export { generateLocalChatCompletion, gemma4DefaultModel } from './core/local-model.js';
