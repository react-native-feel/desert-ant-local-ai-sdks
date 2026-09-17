export { Emo } from './Emo';
export {
  type EmojiSkinTone,
  type EmoLoadOptions,
  type EmoSuggestion,
  type ModelPhase,
  type ProgressEvent,
  type SuggestOptions,
} from './types';

// Re-exported so a caller can catch and branch without adding a second
// dependency for the error type alone.
export { DesertAntError, type DesertAntErrorCode } from '@desert-ant-labs/react-native-core';
