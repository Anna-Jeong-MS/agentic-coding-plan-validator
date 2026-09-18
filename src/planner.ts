import type { PlanInput, PlanTask } from './schemas.js';

export interface PlanIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  taskId?: string;
}

interface ScheduledTask {
  taskId: string;
  wave: number;
  expectedMinutes: number;
  effectiveMinutes: number;
  earliestStartMinutes: number;
  earliestFinishMinutes: number;
  resourceStartMinutes: number;
  resourceFinishMinutes: number;
  priorityScore: number;
  priorityReasons: string[];
}

export interface PlanAnalysis {
  executable: boolean;
  issues: PlanIssue[];
  executionWaves: string[][];
  parallelCandidates: Array<{ taskIds: [string, string]; reason: string }>;
  criticalPath: string[];
  // Dependency-only makespan. Relaxed lower bound that ignores exclusive-resource contention.
  lowerBoundElapsedMinutes: number;
  // Feasible makespan once tasks sharing an exclusive resource are serialized.
  resourceAdjustedElapsedMinutes: number;
  serialEffortMinutes: number;
  schedule: ScheduledTask[];
}

function expectedMinutes(task: PlanTask): number {
  const estimate = task.estimate;
  return Math.ceil((estimate.optimisticMinutes + 4 * estimate.likelyMinutes + estimate.pessimisticMinutes) / 6);
}

function effectiveMinutes(task: PlanTask): number {
  return Math.max(expectedMinutes(task), task.estimate.minimumRealisticMinutes ?? 0);
}

function hasSharedResource(left: PlanTask, right: PlanTask): boolean {
  const resources = new Set(right.exclusiveResources);
  return left.exclusiveResources.some((resource) => resources.has(resource));
}

function emptyAnalysis(issues: PlanIssue[]): PlanAnalysis {
  return {
    executable: false,
    issues,
    executionWaves: [],
    parallelCandidates: [],
    criticalPath: [],
    lowerBoundElapsedMinutes: 0,
    resourceAdjustedElapsedMinutes: 0,
    serialEffortMinutes: 0,
    schedule: []
  };
}

export function analyzePlan(plan: PlanInput): PlanAnalysis {
  const issues: PlanIssue[] = [];
  const tasksById = new Map<string, PlanTask>();

  for (const task of plan.tasks) {
    if (tasksById.has(task.id)) {
      issues.push({ severity: 'error', code: 'DUPLICATE_TASK_ID', taskId: task.id, message: `Task id '${task.id}' is duplicated.` });
    } else {
      tasksById.set(task.id, task);
    }
    const estimate = task.estimate;
    if (!(estimate.optimisticMinutes <= estimate.likelyMinutes && estimate.likelyMinutes <= estimate.pessimisticMinutes)) {
      issues.push({ severity: 'error', code: 'INVALID_ESTIMATE_RANGE', taskId: task.id, message: 'Estimate must satisfy optimistic <= likely <= pessimistic.' });
    }
    if (estimate.minimumRealisticMinutes && expectedMinutes(task) < estimate.minimumRealisticMinutes) {
      issues.push({ severity: 'warning', code: 'OPTIMISTIC_ESTIMATE', taskId: task.id, message: `Expected duration was raised to ${estimate.minimumRealisticMinutes} minutes.` });
    }
    if (estimate.pessimisticMinutes / estimate.optimisticMinutes >= 4) {
      issues.push({ severity: 'warning', code: 'HIGH_UNCERTAINTY', taskId: task.id, message: 'Split the task or add a discovery task.' });
    }
    if (estimate.confidence === 'high' && !estimate.evidence) {
      issues.push({ severity: 'warning', code: 'UNSUPPORTED_CONFIDENCE', taskId: task.id, message: 'High-confidence estimate has no evidence.' });
    }
  }

  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) {
      if (!tasksById.has(dependency)) {
        issues.push({ severity: 'error', code: 'MISSING_DEPENDENCY', taskId: task.id, message: `Dependency '${dependency}' does not exist.` });
      }
    }
  }
  if (issues.some((issue) => ['DUPLICATE_TASK_ID', 'MISSING_DEPENDENCY'].includes(issue.code))) return emptyAnalysis(issues);

  const indegree = new Map(plan.tasks.map((task) => [task.id, task.dependsOn.length]));
  const successors = new Map(plan.tasks.map((task) => [task.id, [] as string[]]));
  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) successors.get(dependency)!.push(task.id);
  }

  const executionWaves: string[][] = [];
  const topologicalOrder: string[] = [];
  let ready = plan.tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id).sort();
  while (ready.length > 0) {
    executionWaves.push(ready);
    topologicalOrder.push(...ready);
    const next: string[] = [];
    for (const id of ready) {
      for (const successor of successors.get(id) ?? []) {
        const remaining = indegree.get(successor)! - 1;
        indegree.set(successor, remaining);
        if (remaining === 0) next.push(successor);
      }
    }
    ready = next.sort();
  }
  if (topologicalOrder.length !== plan.tasks.length) {
    issues.push({ severity: 'error', code: 'DEPENDENCY_CYCLE', message: 'The task graph contains a dependency cycle.' });
    return emptyAnalysis(issues);
  }

  const earliestFinish = new Map<string, number>();
  const criticalParent = new Map<string, string | undefined>();
  for (const id of topologicalOrder) {
    const task = tasksById.get(id)!;
    let start = 0;
    let parent: string | undefined;
    for (const dependency of task.dependsOn) {
      const finish = earliestFinish.get(dependency) ?? 0;
      if (finish > start) {
        start = finish;
        parent = dependency;
      }
    }
    earliestFinish.set(id, start + effectiveMinutes(task));
    criticalParent.set(id, parent);
  }

  const finalTaskId = topologicalOrder.reduce((latest, id) =>
    earliestFinish.get(id)! > earliestFinish.get(latest)! ? id : latest
  );
  const criticalPath: string[] = [];
  for (let id: string | undefined = finalTaskId; id; id = criticalParent.get(id)) criticalPath.unshift(id);

  const remainingPath = new Map<string, number>();
  const descendants = new Map<string, Set<string>>();
  for (const id of [...topologicalOrder].reverse()) {
    const children = successors.get(id) ?? [];
    const all = new Set<string>();
    for (const child of children) {
      all.add(child);
      for (const descendant of descendants.get(child) ?? []) all.add(descendant);
    }
    descendants.set(id, all);
    remainingPath.set(id, effectiveMinutes(tasksById.get(id)!) + Math.max(0, ...children.map((child) => remainingPath.get(child) ?? 0)));
  }

  // Resource-feasible schedule: both dependencies and exclusive resources gate a task's start,
  // so tasks sharing a resource are serialized instead of silently overlapping.
  const resourceFreeAt = new Map<string, number>();
  const resourceStart = new Map<string, number>();
  const resourceFinish = new Map<string, number>();
  for (const id of topologicalOrder) {
    const task = tasksById.get(id)!;
    let start = 0;
    for (const dependency of task.dependsOn) start = Math.max(start, resourceFinish.get(dependency) ?? 0);
    for (const resource of task.exclusiveResources) start = Math.max(start, resourceFreeAt.get(resource) ?? 0);
    const finish = start + effectiveMinutes(task);
    resourceStart.set(id, start);
    resourceFinish.set(id, finish);
    for (const resource of task.exclusiveResources) resourceFreeAt.set(resource, finish);
  }

  const waveById = new Map(executionWaves.flatMap((wave, index) => wave.map((id) => [id, index] as const)));
  const schedule = topologicalOrder.map((id) => {
    const task = tasksById.get(id)!;
    const effective = effectiveMinutes(task);
    const descendantCount = descendants.get(id)?.size ?? 0;
    const reasons: string[] = [];
    if (criticalPath.includes(id)) reasons.push('critical path');
    if (descendantCount > 0) reasons.push(`prerequisite for ${descendantCount} downstream task(s)`);
    if (effective >= 60) reasons.push('long-running task');
    return {
      taskId: id,
      wave: waveById.get(id)!,
      expectedMinutes: expectedMinutes(task),
      effectiveMinutes: effective,
      earliestStartMinutes: earliestFinish.get(id)! - effective,
      earliestFinishMinutes: earliestFinish.get(id)!,
      resourceStartMinutes: resourceStart.get(id)!,
      resourceFinishMinutes: resourceFinish.get(id)!,
      priorityScore: remainingPath.get(id)! + descendantCount * 10,
      priorityReasons: reasons
    };
  }).sort((left, right) => left.wave - right.wave || right.priorityScore - left.priorityScore || left.taskId.localeCompare(right.taskId));

  // Parallel candidates: any two independent tasks with no shared exclusive resource whose
  // earliest execution windows overlap, even across different waves.
  const earliestStartOf = (id: string) => earliestFinish.get(id)! - effectiveMinutes(tasksById.get(id)!);
  const parallelCandidates: PlanAnalysis['parallelCandidates'] = [];
  for (let leftIndex = 0; leftIndex < topologicalOrder.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < topologicalOrder.length; rightIndex += 1) {
      const leftId = topologicalOrder[leftIndex];
      const rightId = topologicalOrder[rightIndex];
      if (descendants.get(leftId)!.has(rightId) || descendants.get(rightId)!.has(leftId)) continue;
      if (hasSharedResource(tasksById.get(leftId)!, tasksById.get(rightId)!)) continue;
      const overlaps = earliestStartOf(leftId) < earliestFinish.get(rightId)! && earliestStartOf(rightId) < earliestFinish.get(leftId)!;
      if (overlaps) {
        parallelCandidates.push({ taskIds: [leftId, rightId], reason: 'No dependency path or shared exclusive resource.' });
      }
    }
  }

  const lowerBoundElapsedMinutes = Math.max(...earliestFinish.values());
  const resourceAdjustedElapsedMinutes = Math.max(...resourceFinish.values());
  if (resourceAdjustedElapsedMinutes > lowerBoundElapsedMinutes) {
    const serialized = plan.tasks
      .flatMap((task) => task.exclusiveResources)
      .filter((resource, index, all) => all.indexOf(resource) === index && all.indexOf(resource) !== all.lastIndexOf(resource))
      .sort();
    issues.push({
      severity: 'warning',
      code: 'RESOURCE_CONTENTION',
      message: `Exclusive resources force serialization: ${serialized.join(', ')}. Dependency-only lower bound is ${lowerBoundElapsedMinutes} min; resource-feasible makespan is ${resourceAdjustedElapsedMinutes} min.`
    });
  }

  return {
    executable: !issues.some((issue) => issue.severity === 'error'),
    issues,
    executionWaves,
    parallelCandidates,
    criticalPath,
    lowerBoundElapsedMinutes,
    resourceAdjustedElapsedMinutes,
    serialEffortMinutes: plan.tasks.reduce((total, task) => total + effectiveMinutes(task), 0),
    schedule
  };
}