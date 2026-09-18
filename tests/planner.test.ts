import { describe, expect, it } from 'vitest';
import { analyzePlan } from '../src/planner.js';
import type { PlanInput } from '../src/schemas.js';

const estimate = (likelyMinutes: number, minimumRealisticMinutes?: number) => ({
  optimisticMinutes: Math.ceil(likelyMinutes * 0.7),
  likelyMinutes,
  pessimisticMinutes: Math.ceil(likelyMinutes * 1.5),
  confidence: 'medium' as const,
  minimumRealisticMinutes
});

describe('analyzePlan', () => {
  it('finds parallel work and the critical path in the Azure example', () => {
    const plan: PlanInput = {
      goal: 'Build and deploy an application using Azure App Service and Azure SQL',
      tasks: [
        { id: 'design', title: 'Design application', category: 'design', estimate: estimate(30), dependsOn: [], exclusiveResources: [] },
        { id: 'app', title: 'Implement application', category: 'implementation', estimate: estimate(90), dependsOn: ['design'], exclusiveResources: ['repository'] },
        { id: 'app-service', title: 'Provision App Service', category: 'infrastructure', estimate: estimate(8, 10), dependsOn: ['design'], exclusiveResources: [] },
        { id: 'sql', title: 'Provision Azure SQL', category: 'infrastructure', estimate: estimate(12, 15), dependsOn: ['design'], exclusiveResources: [] },
        { id: 'configure', title: 'Configure application', category: 'deployment', estimate: estimate(15), dependsOn: ['app', 'app-service', 'sql'], exclusiveResources: [] },
        { id: 'smoke', title: 'Run smoke tests', category: 'test', estimate: estimate(10), dependsOn: ['configure'], exclusiveResources: [] }
      ]
    };

    const result = analyzePlan(plan);
    expect(result.executable).toBe(true);
    expect(result.executionWaves[1]).toEqual(['app', 'app-service', 'sql']);
    expect(result.parallelCandidates).toContainEqual({ taskIds: ['app-service', 'sql'], reason: 'No dependency path or shared exclusive resource.' });
    expect(result.criticalPath).toEqual(['design', 'app', 'configure', 'smoke']);
    expect(result.issues.map((issue) => issue.code)).toContain('OPTIMISTIC_ESTIMATE');
  });

  it('rejects missing dependencies', () => {
    const result = analyzePlan({
      goal: 'Invalid plan',
      tasks: [{ id: 'deploy', title: 'Deploy', category: 'deployment', estimate: estimate(10), dependsOn: ['build'], exclusiveResources: [] }]
    });
    expect(result.executable).toBe(false);
    expect(result.issues[0].code).toBe('MISSING_DEPENDENCY');
  });

  it('rejects dependency cycles', () => {
    const result = analyzePlan({
      goal: 'Cyclic plan',
      tasks: [
        { id: 'a', title: 'A', category: 'custom', estimate: estimate(10), dependsOn: ['b'], exclusiveResources: [] },
        { id: 'b', title: 'B', category: 'custom', estimate: estimate(10), dependsOn: ['a'], exclusiveResources: [] }
      ]
    });
    expect(result.executable).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('DEPENDENCY_CYCLE');
  });

  it('serializes tasks sharing an exclusive resource in the resource-aware makespan', () => {
    const result = analyzePlan({
      goal: 'Two tasks lock the same database',
      tasks: [
        { id: 'migrate', title: 'Migrate schema', category: 'data', estimate: estimate(30), dependsOn: [], exclusiveResources: ['db'] },
        { id: 'backfill', title: 'Backfill data', category: 'data', estimate: estimate(30), dependsOn: [], exclusiveResources: ['db'] }
      ]
    });
    expect(result.lowerBoundElapsedMinutes).toBe(31);
    expect(result.resourceAdjustedElapsedMinutes).toBe(62);
    expect(result.issues.map((issue) => issue.code)).toContain('RESOURCE_CONTENTION');
    expect(result.parallelCandidates).toHaveLength(0);
    const later = result.schedule.find((task) => task.resourceStartMinutes === 31);
    expect(later).toBeDefined();
  });

  it('finds a cross-wave parallel candidate when execution windows overlap', () => {
    const result = analyzePlan({
      goal: 'A long task overlaps a downstream short task',
      tasks: [
        { id: 'a-long', title: 'Long build', category: 'implementation', estimate: estimate(60), dependsOn: [], exclusiveResources: [] },
        { id: 'b-short', title: 'Quick probe', category: 'discovery', estimate: estimate(5), dependsOn: [], exclusiveResources: [] },
        { id: 'c-after-b', title: 'Follow-up', category: 'implementation', estimate: estimate(5), dependsOn: ['b-short'], exclusiveResources: [] }
      ]
    });
    expect(result.parallelCandidates).toContainEqual({ taskIds: ['a-long', 'c-after-b'], reason: 'No dependency path or shared exclusive resource.' });
    expect(result.parallelCandidates).not.toContainEqual({ taskIds: ['b-short', 'c-after-b'], reason: 'No dependency path or shared exclusive resource.' });
  });
});