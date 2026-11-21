import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION, REJECTION, validateScalingSignal } from '../src/index.js';

const baseReplica = {
  replicas: 2,
  minReplicas: 1,
  qpsPerReplica: 2,
  queueLength: 0,
  gpuMemoryMb: 24576,
  weightsMemoryMb: 14336,
  runtimeMemoryMb: 2048,
  p95LatencyMs: 300,
  coldStartSeconds: 45,
  tokenDistribution: [
    { tokens: 512, weight: 7 },
    { tokens: 2048, weight: 3 },
  ],
};

const sample = (overrides = {}) => ({
  qpsPerReplica: 2,
  queueLength: 0,
  p95LatencyMs: 300,
  gpuUtilization: 0.4,
  ...overrides,
});

const sustainedBreachHistory = () => [
  sample({ t: 0, qpsPerReplica: 4, p95LatencyMs: 950, queueLength: 12 }),
  sample({ t: 15, qpsPerReplica: 4, p95LatencyMs: 950, queueLength: 12 }),
  sample({ t: 30, qpsPerReplica: 4, p95LatencyMs: 950, queueLength: 12 }),
  sample({ t: 45, qpsPerReplica: 4, p95LatencyMs: 950, queueLength: 12 }),
  sample({ t: 60, qpsPerReplica: 4, p95LatencyMs: 950, queueLength: 12 }),
];

const sustainedLowLoadHistory = () => {
  const points = [];
  for (let index = 0; index <= 20; index += 1) {
    points.push(sample({
      t: index * 15,
      qpsPerReplica: 0.3,
      p95LatencyMs: 120,
      queueLength: 0,
      gpuUtilization: 0.15,
    }));
  }
  return points;
};

describe('突发流量', () => {
  it('单次尖峰未持续越线时拒绝扩容', () => {
    const result = validateScalingSignal({
      current: {
        ...baseReplica,
        qpsPerReplica: 4,
        queueLength: 12,
        p95LatencyMs: 950,
        history: [
          sample({ t: 0 }),
          sample({ t: 15 }),
          sample({ t: 30 }),
          sample({ t: 45, qpsPerReplica: 4, p95LatencyMs: 950, queueLength: 12 }),
          sample({ t: 60 }),
        ],
      },
    });
    assert.equal(result.overallAction, ACTION.REJECTED);
    assert.equal(result.rejections[0].code, REJECTION.SUSTAIN_NOT_MET);
    assert.equal(result.recommendedReplicas, 2);
  });

  it('持续越线的突发流量触发扩容并报告冷启动风险', () => {
    const result = validateScalingSignal({
      current: {
        ...baseReplica,
        qpsPerReplica: 4,
        queueLength: 12,
        p95LatencyMs: 950,
        history: sustainedBreachHistory(),
      },
      predictedTrafficQps: 20,
    });
    assert.equal(result.overallAction, ACTION.SCALE_UP);
    assert.ok(result.recommendedReplicas > 2);
    assert.equal(result.effectiveAfterSeconds, 45);
    assert.ok(result.signals.scaleUp.sustained);
    assert.deepEqual(result.signals.scaleUp.breachReasons.sort(),
      ['LATENCY_P95', 'QPS_UTILIZATION', 'QUEUE_LENGTH'].sort());
    const riskCodes = result.risks.map((risk) => risk.code);
    assert.ok(riskCodes.includes('COLD_START_WINDOW'));
    assert.ok(riskCodes.includes('OVERLOAD_DURING_WARMUP'));
    assert.ok(riskCodes.includes('QUEUE_BACKLOG'));
  });

  it('预测流量可跳过持续越线门限做预防性扩容', () => {
    const result = validateScalingSignal({
      current: {
        ...baseReplica,
        history: [sample({ t: 0 }), sample({ t: 15 })],
      },
      predictedTrafficQps: 30,
    });
    assert.equal(result.overallAction, ACTION.SCALE_UP);
    assert.equal(result.steps[0].trigger, 'PREDICTED_TRAFFIC');
  });
});

describe('显存瓶颈', () => {
  it('大请求占满显存时容量由显存决定，并输出显存压力风险', () => {
    const result = validateScalingSignal({
      current: {
        ...baseReplica,
        qpsPerReplica: 0.8,
        queueLength: 2,
        p95LatencyMs: 500,
        gpuMemoryMb: 24576,
        weightsMemoryMb: 21504,
        runtimeMemoryMb: 2048,
        tokenDistribution: [{ tokens: 16384, weight: 1 }],
        history: [
          sample({ t: 0, gpuUtilization: 0.92, p95LatencyMs: 500, queueLength: 2 }),
          sample({ t: 15, gpuUtilization: 0.92, p95LatencyMs: 500, queueLength: 2 }),
          sample({ t: 30, gpuUtilization: 0.92, p95LatencyMs: 500, queueLength: 2 }),
          sample({ t: 45, gpuUtilization: 0.92, p95LatencyMs: 500, queueLength: 2 }),
          sample({ t: 60, gpuUtilization: 0.92, p95LatencyMs: 500, queueLength: 2 }),
        ],
      },
    });
    const perReplica = result.capacity.perReplica;
    assert.equal(perReplica.memoryConstrained, true);
    assert.ok(perReplica.memoryQpsLimit < perReplica.computeQpsLimit);
    assert.equal(result.overallAction, ACTION.SCALE_UP);
    assert.ok(result.risks.some((risk) => risk.code === 'GPU_MEMORY_PRESSURE'));
  });
});

describe('阈值抖动', () => {
  it('越线与恢复反复切换时拒绝扩容', () => {
    const result = validateScalingSignal({
      current: {
        ...baseReplica,
        qpsPerReplica: 4,
        p95LatencyMs: 950,
        history: [
          sample({ t: 0, p95LatencyMs: 950 }),
          sample({ t: 15 }),
          sample({ t: 30, p95LatencyMs: 950 }),
          sample({ t: 45 }),
          sample({ t: 60, p95LatencyMs: 950 }),
        ],
      },
    });
    assert.equal(result.overallAction, ACTION.REJECTED);
    assert.equal(result.rejections[0].code, REJECTION.JITTER_BREACH);
    assert.ok(result.signals.scaleUp.flapping);
  });

  it('冷却期内任何扩缩容信号都被拒绝', () => {
    const result = validateScalingSignal({
      current: {
        ...baseReplica,
        qpsPerReplica: 4,
        p95LatencyMs: 950,
        history: sustainedBreachHistory().map((entry, index) =>
          index === 0 ? { ...entry, lastScaleActionAt: 0 } : entry),
      },
    });
    assert.equal(result.overallAction, ACTION.REJECTED);
    assert.equal(result.rejections[0].code, REJECTION.COOLDOWN_ACTIVE);
  });
});

describe('版本切换', () => {
  const versionEntry = (version, overrides = {}) => ({
    version,
    predictedTrafficQps: 0,
    current: {
      ...baseReplica,
      replicas: 2,
      qpsPerReplica: 4,
      p95LatencyMs: 950,
      queueLength: 12,
      history: sustainedBreachHistory(),
      ...overrides,
    },
  });

  it('新旧版本独立计算，不直接相加信号', () => {
    const result = validateScalingSignal({
      versionSwitch: true,
      versions: [
        versionEntry('v1'),
        versionEntry('v2', {
          replicas: 1,
          minReplicas: 1,
          qpsPerReplica: 1,
          p95LatencyMs: 250,
          queueLength: 0,
          history: [
            sample({ t: 0, qpsPerReplica: 1, p95LatencyMs: 250 }),
            sample({ t: 15, qpsPerReplica: 1, p95LatencyMs: 250 }),
          ],
        }),
      ],
    });
    assert.equal(result.mode, 'VERSION_SWITCH');
    const [v1, v2] = result.steps;
    assert.equal(v1.groupId, 'v1');
    assert.equal(v1.action, ACTION.SCALE_UP);
    assert.equal(v2.groupId, 'v2');
    assert.equal(v2.action, ACTION.REJECTED);
    assert.equal(v2.rejections[0].code, REJECTION.MIN_REPLICAS);
    assert.equal(result.capacity.perVersion[0].version, 'v1');
    assert.ok(result.capacity.perVersion[0].currentTotalQps > 0);
  });

  it('版本切换期间提供聚合 current 直接拒绝', () => {
    assert.throws(() => validateScalingSignal({
      versionSwitch: true,
      current: baseReplica,
      versions: [versionEntry('v1'), versionEntry('v2')],
    }), (error) => error.code === REJECTION.VERSION_SIGNAL_MIXED);
  });
});

describe('节点容量不足', () => {
  it('节点池无余量时拒绝扩容', () => {
    const result = validateScalingSignal({
      current: {
        ...baseReplica,
        qpsPerReplica: 4,
        p95LatencyMs: 950,
        queueLength: 12,
        history: sustainedBreachHistory(),
      },
      nodePool: { maxReplicas: 2, currentReplicas: 2 },
    });
    assert.equal(result.overallAction, ACTION.REJECTED);
    assert.equal(result.rejections[0].code, REJECTION.NODE_CAPACITY_INSUFFICIENT);
  });

  it('节点池余量不足时截断扩容并保留拒绝原因', () => {
    const result = validateScalingSignal({
      current: {
        ...baseReplica,
        qpsPerReplica: 4,
        p95LatencyMs: 950,
        queueLength: 12,
        history: sustainedBreachHistory(),
      },
      predictedTrafficQps: 40,
      nodePool: { maxReplicas: 3, currentReplicas: 2 },
    });
    assert.equal(result.overallAction, ACTION.SCALE_UP);
    assert.equal(result.recommendedReplicas, 3);
    assert.ok(result.risks.some((item) => item.code === 'NODE_CAPACITY_CAPPED'));
    assert.ok(result.risks.some((risk) => risk.code === 'NODE_POOL_NEAR_LIMIT'));
  });
});

describe('缩容', () => {
  it('短时间低负载不允许缩容', () => {
    const result = validateScalingSignal({
      current: {
        ...baseReplica,
        replicas: 4,
        minReplicas: 1,
        qpsPerReplica: 0.3,
        p95LatencyMs: 120,
        history: [
          sample({ t: 0, qpsPerReplica: 0.3, p95LatencyMs: 120 }),
          sample({ t: 15, qpsPerReplica: 0.3, p95LatencyMs: 120 }),
        ],
      },
    });
    assert.equal(result.overallAction, ACTION.REJECTED);
    assert.equal(result.rejections[0].code, REJECTION.SCALE_DOWN_NOT_SUSTAINED);
  });

  it('长时间低负载且队列清空时缩一个副本，生效时间含连接排空', () => {
    const result = validateScalingSignal({
      current: {
        ...baseReplica,
        replicas: 6,
        minReplicas: 1,
        qpsPerReplica: 0.3,
        p95LatencyMs: 120,
        history: sustainedLowLoadHistory(),
      },
    });
    assert.equal(result.overallAction, ACTION.SCALE_DOWN);
    assert.equal(result.recommendedReplicas, 5);
    assert.equal(result.effectiveAfterSeconds, 30);
  });

  it('触及最小副本或预热预留时拒绝缩容', () => {
    const minResult = validateScalingSignal({
      current: {
        ...baseReplica,
        replicas: 1,
        minReplicas: 1,
        qpsPerReplica: 0.2,
        p95LatencyMs: 100,
        history: sustainedLowLoadHistory(),
      },
    });
    assert.equal(minResult.rejections[0].code, REJECTION.MIN_REPLICAS);

    const reserveResult = validateScalingSignal({
      current: {
        ...baseReplica,
        replicas: 2,
        minReplicas: 1,
        qpsPerReplica: 0.8,
        p95LatencyMs: 150,
        history: sustainedLowLoadHistory(),
      },
      predictedTrafficQps: 2.5,
    });
    assert.equal(reserveResult.overallAction, ACTION.REJECTED);
    assert.ok(reserveResult.rejections.some((item) =>
      item.code === REJECTION.WARMUP_RESERVE || item.code === REJECTION.MIN_REPLICAS));
  });
});

describe('输入校验', () => {
  it('缺少必要指标时抛出 INVALID_INPUT', () => {
    assert.throws(() => validateScalingSignal({
      current: { ...baseReplica, tokenDistribution: [] },
    }), (error) => error.code === REJECTION.INVALID_INPUT);
  });
});
