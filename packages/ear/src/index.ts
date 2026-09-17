export { Ear } from './Ear';
export {
  type Detection,
  type EarLoadOptions,
  type IdentifyFileOptions,
  type IdentifyOptions,
  type LanguageCandidate,
  type ModelPhase,
  type ProgressEvent,
} from './types';

// Re-exported so a caller can catch and branch without adding a second
// dependency for the error type alone.
export { DesertAntError, type DesertAntErrorCode } from '@desert-ant-labs/react-native-core';
