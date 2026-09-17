import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { analyzePlan } from './planner.js';
import { planSchema } from './schemas.js';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'agentic-coding-plan-validator', version: '0.1.0' });

  server.registerTool(
    'validate_coding_plan',
    {
      description: 'Validate a coding task DAG, estimates, dependencies, parallel candidates, critical path, and execution priority.',
      inputSchema: planSchema
    },
    async (plan) => {
      const analysis = analyzePlan(plan);
      return {
        content: [{ type: 'text', text: JSON.stringify(analysis, null, 2) }],
        structuredContent: { ...analysis }
      };
    }
  );

  return server;
}

void serveStdio(createServer);
console.error('agentic-coding-plan-validator MCP server running on stdio');