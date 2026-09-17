export { Tongue } from './Tongue';
export {
  type Detection,
  type DetectOptions,
  type LanguageCandidate,
  type Reliability,
  type Route,
  type RouteVerdict,
} from './types';

// Re-exported so a caller can catch and branch without adding a second
// dependency for the error type alone.
export { DesertAntError, type DesertAntErrorCode } from '@desert-ant-labs/react-native-core';
