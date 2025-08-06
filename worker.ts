/// <reference types="@cloudflare/workers-types" />

import tasks from "./tasks.json";
export interface Env {
  PARALLEL_API_KEY: string;
  TASK_RESULTS: KVNamespace;
  WEBHOOK_URL: string;
}

interface Task {
  slug: string;
  name: string;
  description: string;
  task_spec: {
    output_schema: any;
  };
  input: string;
  processor: string;
}

interface TaskResult {
  task: Task;
  result: any;
  lastUpdated: string;
  status: "completed" | "failed";
  error?: string;
}

const TASKS: Task[] = tasks.tasks;
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Validate required environment variables
    if (!env.PARALLEL_API_KEY) {
      return new Response("Missing PARALLEL_API_KEY environment variable", {
        status: 500,
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Handle webhook callbacks
    if (path === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }

    // Handle manual run trigger
    if (path === "/run" && request.method === "GET") {
      const apiKey = url.searchParams.get("key");
      if (apiKey !== env.PARALLEL_API_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Trigger all tasks
      ctx.waitUntil(runAllTasks(env));
      return new Response("Tasks triggered successfully");
    }

    // Handle individual task results
    const taskSlug = path.substring(1); // Remove leading slash
    const task = TASKS.find((t) => t.slug === taskSlug);
    if (task) {
      return handleTaskPage(task, env);
    }

    // Handle homepage
    if (path === "/") {
      return handleHomepage(env);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    // Run at 3 AM daily
    ctx.waitUntil(runAllTasks(env));
  },
} satisfies ExportedHandler<Env>;

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  try {
    const payload = (await request.json()) as any;

    if (
      payload.type === "task_run.status" &&
      payload.data.status === "completed"
    ) {
      const runId = payload.data.run_id;

      // Get the full result
      const resultResponse = await fetch(
        `https://api.parallel.ai/v1/tasks/runs/${runId}/result`,
        {
          headers: {
            "x-api-key": env.PARALLEL_API_KEY,
          },
        }
      );

      if (resultResponse.ok) {
        const resultData = await resultResponse.json();

        // Find which task this belongs to by checking metadata or other identifiers
        // For now, we'll store with a generic key and let the manual trigger handle specific tasks
        const taskSlug = payload.data.metadata?.task_slug;
        if (taskSlug) {
          const task = TASKS.find((t) => t.slug === taskSlug);
          if (task) {
            const taskResult: TaskResult = {
              task,
              result: resultData.output.content,
              lastUpdated: new Date().toISOString(),
              status: "completed",
            };

            await env.TASK_RESULTS.put(taskSlug, JSON.stringify(taskResult));
          }
        }
      }
    }

    return new Response("OK");
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response("Error processing webhook", { status: 500 });
  }
}

async function runAllTasks(env: Env): Promise<void> {
  const webhookUrl = env.WEBHOOK_URL;

  for (const task of TASKS) {
    try {
      const response = await fetch("https://api.parallel.ai/v1/tasks/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.PARALLEL_API_KEY,
        },
        body: JSON.stringify({
          task_spec: task.task_spec,
          input: task.input,
          processor: task.processor,
          metadata: {
            task_slug: task.slug,
          },
          webhook: {
            url: webhookUrl,
            event_types: ["task_run.status"],
          },
        }),
      });

      if (!response.ok) {
        console.error(
          `Failed to start task ${task.slug}:`,
          await response.text()
        );
      }
    } catch (error) {
      console.error(`Error starting task ${task.slug}:`, error);
    }
  }
}

async function handleTaskPage(task: Task, env: Env): Promise<Response> {
  const stored = await env.TASK_RESULTS.get(task.slug);
  let taskResult: TaskResult | null = null;

  if (stored) {
    try {
      taskResult = JSON.parse(stored);
    } catch (error) {
      console.error("Error parsing stored result:", error);
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${task.name} - parallel daily insights</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        body { font-family: 'Inter', sans-serif; }
        @media (prefers-color-scheme: dark) {
            body { background-color: #1a1a1a; color: #ffffff; }
        }
    </style>
</head>
<body class="min-h-screen bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
    <div class="max-w-4xl mx-auto px-4 py-8">
        <div class="mb-8">
            <a href="/" class="text-blue-600 dark:text-blue-400 hover:underline text-sm">&larr; Back to all tasks</a>
        </div>
        
        <header class="mb-8">
            <h1 class="text-3xl font-bold mb-2">${task.name}</h1>
            <p class="text-gray-600 dark:text-gray-400">${task.description}</p>
        </header>

        ${
          taskResult
            ? `
        <div class="bg-gray-50 dark:bg-gray-800 rounded-lg p-6 mb-6">
            <div class="flex justify-between items-center mb-4">
                <h2 class="text-xl font-semibold">Latest Results</h2>
                <span class="text-sm text-gray-500 dark:text-gray-400">
                    Updated: ${new Date(
                      taskResult.lastUpdated
                    ).toLocaleDateString()}
                </span>
            </div>
            
            ${Object.entries(taskResult.result)
              .map(
                ([key, value]) => `
                <div class="mb-4">
                    <h3 class="font-medium text-gray-800 dark:text-gray-200 mb-2 capitalize">
                        ${key.replace(/_/g, " ")}
                    </h3>
                    <p class="text-gray-700 dark:text-gray-300 leading-relaxed">${String(
                      value
                    )}</p>
                </div>
            `
              )
              .join("")}
        </div>
        `
            : `
        <div class="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-6">
            <p class="text-yellow-800 dark:text-yellow-200">
                No results available yet. Results are updated daily at 3 AM UTC.
            </p>
        </div>
        `
        }
        
        <footer class="text-center text-sm text-gray-500 dark:text-gray-400 mt-8">
            <p>Powered by <strong>parallel</strong> daily insights</p>
        </footer>
    </div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

async function handleHomepage(env: Env): Promise<Response> {
  // Get all stored results
  const results: Record<string, TaskResult> = {};

  for (const task of TASKS) {
    const stored = await env.TASK_RESULTS.get(task.slug);
    if (stored) {
      try {
        results[task.slug] = JSON.parse(stored);
      } catch (error) {
        console.error(`Error parsing result for ${task.slug}:`, error);
      }
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>parallel daily insights</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        body { font-family: 'Inter', sans-serif; }
        @media (prefers-color-scheme: dark) {
            body { background-color: #1a1a1a; color: #ffffff; }
        }
    </style>
</head>
<body class="min-h-screen bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
    <div class="max-w-6xl mx-auto px-4 py-8">
        <header class="text-center mb-12">
            <h1 class="text-4xl font-bold mb-4">
                <span class="font-black">parallel</span> daily insights
            </h1>
            <p class="text-gray-600 dark:text-gray-400 text-lg max-w-2xl mx-auto">
                Automated daily research tasks powered by Parallel.ai. Fresh insights delivered every morning at 3 AM UTC.
            </p>
        </header>

        <div class="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            ${TASKS.map((task) => {
              const result = results[task.slug];
              return `
                <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow">
                    <div class="p-6">
                        <h2 class="text-xl font-semibold mb-2">
                            <a href="/${
                              task.slug
                            }" class="hover:text-blue-600 dark:hover:text-blue-400">
                                ${task.name}
                            </a>
                        </h2>
                        <p class="text-gray-600 dark:text-gray-400 text-sm mb-4">${
                          task.description
                        }</p>
                        
                        ${
                          result
                            ? `
                            <div class="text-xs text-gray-500 dark:text-gray-400 mb-2">
                                Last updated: ${new Date(
                                  result.lastUpdated
                                ).toLocaleDateString()}
                            </div>
                            <div class="text-sm text-gray-700 dark:text-gray-300">
                                ${
                                  Object.values(result.result)[0]
                                    ? String(
                                        Object.values(result.result)[0]
                                      ).substring(0, 150) + "..."
                                    : "Results available"
                                }
                            </div>
                        `
                            : `
                            <div class="text-sm text-yellow-600 dark:text-yellow-400">
                                Awaiting first run...
                            </div>
                        `
                        }
                        
                        <div class="mt-4">
                            <a href="/${task.slug}" 
                               class="inline-flex items-center text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline">
                                View Details →
                            </a>
                        </div>
                    </div>
                </div>
              `;
            }).join("")}
        </div>
        
        <footer class="text-center mt-12">
            <div class="text-sm text-gray-500 dark:text-gray-400 space-y-2">
                <p>Tasks run automatically daily at 3 AM UTC</p>
                <p>Powered by <strong>parallel</strong> web intelligence</p>
            </div>
        </footer>
    </div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}
