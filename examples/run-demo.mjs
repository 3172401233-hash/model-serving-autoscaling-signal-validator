import { validateScalingSignal } from '../src/index.js';

const sample = (overrides = {}) => ({
  qpsPerReplica: 2,
  queueLength: 0,
  p95LatencyMs: 300,
  gpuUtilization: 0.4,
  ...overrides,
});

const sustainedBreach = [0, 15, 30, 45, 60].map((t) => sample({
  t,
  qpsPerReplica: 4,
  queueLength: 12,
  p95LatencyMs: 950,
  gpuUtilization: 0.7,
}));

const result = validateScalingSignal({
  predictedTrafficQps: 20,
  current: {
    replicas: 2,
    minReplicas: 1,
    qpsPerReplica: 4,
    queueLength: 12,
    gpuMemoryMb: 24576,
    weightsMemoryMb: 14336,
    runtimeMemoryMb: 2048,
    p95LatencyMs: 950,
    coldStartSeconds: 45,
    tokenDistribution: [
      { tokens: 512, weight: 7 },
      { tokens: 2048, weight: 3 },
    ],
    history: sustainedBreach,
  },
  nodePool: { maxReplicas: 6, currentReplicas: 2 },
});

console.log(JSON.stringify(result, null, 2));
