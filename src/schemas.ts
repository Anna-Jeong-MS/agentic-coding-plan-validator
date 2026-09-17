import * as z from 'zod/v4';

export const taskCategorySchema = z.enum([
  'discovery', 'design', 'implementation', 'test', 'infrastructure', 'data',
  'security', 'deployment', 'review', 'documentation', 'approval', 'custom'
]);

export const estimateSchema = z.object({
  optimisticMinutes: z.number().positive(),
  likelyMinutes: z.number().positive(),
  pessimisticMinutes: z.number().positive(),
  confidence: z.enum(['low', 'medium', 'high']).default('medium'),
  minimumRealisticMinutes: z.number().positive().optional(),
  evidence: z.string().min(1).optional()
});

export const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: taskCategorySchema,
  estimate: estimateSchema,
  dependsOn: z.array(z.string().min(1)).default([]),
  exclusiveResources: z.array(z.string().min(1)).default([])
});

export const planSchema = z.object({
  goal: z.string().min(1),
  tasks: z.array(taskSchema).min(1)
});

export type PlanInput = z.infer<typeof planSchema>;
export type PlanTask = z.infer<typeof taskSchema>;