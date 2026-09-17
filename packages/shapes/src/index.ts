export { Shapes } from './Shapes';
export { DEFAULT_OUTLINE_SAMPLES, isClosed, outline } from './outline';
export {
  type EllipseShape,
  type LineShape,
  type ModelPhase,
  type Point,
  type ProgressEvent,
  type RecognizeOptions,
  type Recognition,
  type RectangleShape,
  type Shape,
  type ShapeKind,
  type ShapesLoadOptions,
  type StarShape,
  type TriangleShape,
} from './types';

// Re-exported so a caller can catch and branch without adding a second
// dependency for the error type alone.
export { DesertAntError, type DesertAntErrorCode } from '@desert-ant-labs/react-native-core';
