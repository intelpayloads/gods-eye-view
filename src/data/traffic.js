import { createTrafficSource } from '../layers/traffic/source.js';
import { createTrafficLayer } from '../layers/traffic/index.js';
import * as credits from './dataCredits.js';
import * as render from '../renderGovernor.js';
import { apiUrl } from '../sources/endpoints.js';
import { createLayerSource } from '../sources/layerSources.js';

const layer = createTrafficLayer({
  source: createLayerSource('traffic', createTrafficSource({ api: apiUrl })),
  services: { credits, render },
});
export const getTrafficTimingDiagnostics = layer.getTrafficTimingDiagnostics;
export const deriveTrafficFlowError = layer.deriveTrafficFlowError;
export const trafficFeedPresentation = layer.trafficFeedPresentation;
export default layer;
