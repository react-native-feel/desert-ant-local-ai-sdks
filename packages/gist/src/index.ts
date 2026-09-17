export { Gist } from './Gist';
export { channelTopics } from './channel';
export {
  type ChannelTopic,
  type ClassifyOptions,
  type Distribution,
  type GistLoadOptions,
  type GistVariant,
  type ModelPhase,
  type PostTopics,
  type ProgressEvent,
  type RollupOptions,
  type Tagging,
  type Topic,
} from './types';

// Re-exported so a caller can catch and branch without adding a second
// dependency for the error type alone.
export { DesertAntError, type DesertAntErrorCode } from '@desert-ant-labs/react-native-core';
