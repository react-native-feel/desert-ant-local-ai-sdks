export { DesertAntError, toDesertAntError, type DesertAntErrorCode } from './errors';
export {
  type ModelLoadOptions,
  type ModelPhase,
  type ProgressEvent,
  type Releasable,
} from './model';

/**
 * The license every Desert Ant model ships under. Free below 100,000 monthly
 * active devices per platform per model; attribution is required in-app.
 *
 * @see https://license.desertant.com/1.0
 * @see https://license.desertant.com/attribution
 */
export const LICENSE = {
  id: 'LicenseRef-DAL-Source-Available-1.0',
  url: 'https://license.desertant.com/1.0',
  attributionUrl: 'https://license.desertant.com/attribution',
} as const;
