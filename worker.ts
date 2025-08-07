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

interface WebhookPayload {
  timestamp: string;
  type: string;
  data: {
    run_id: string;
    status: "completed" | "failed";
    is_active: boolean;
    warnings?: any;
    error?: {
      message: string;
      details?: string;
    };
    processor: string;
    metadata?: {
      task_slug?: string;
      [key: string]: any;
    };
    created_at: string;
    modified_at: string;
  };
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

async function verifyWebhookSignature(
  body: string,
  secret: string,
  headerSignature: string,
  webhookId: string,
  webhookTimestamp: string
): Promise<boolean> {
  try {
    // Create the payload string: webhook_id.timestamp.body
    const payload = `${webhookId}.${webhookTimestamp}.${body}`;

    // Import the secret as a key
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    // Generate HMAC-SHA256 signature
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload)
    );

    // Convert to base64url format (URL-safe base64 without padding)
    const signatureArray = new Uint8Array(signature);
    const base64 = btoa(String.fromCharCode(...signatureArray));
    const base64url = base64
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    // Parse version and signature from header (format: "v1,<signature>")
    const headerSignatures = headerSignature.split(" ");

    for (const sig of headerSignatures) {
      const [version, receivedSig] = sig.split(",", 2);
      if (version === "v1" && receivedSig === base64url) {
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error("Signature verification error:", error);
    return false;
  }
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  try {
    const webhookId = request.headers.get("webhook-id");
    const webhookTimestamp = request.headers.get("webhook-timestamp");
    const webhookSignature = request.headers.get("webhook-signature");

    if (!webhookId || !webhookTimestamp || !webhookSignature) {
      console.error("Missing webhook headers");
      return new Response("Missing required webhook headers", { status: 400 });
    }

    // Verify timestamp is recent (within 5 minutes to prevent replay attacks)
    const now = Math.floor(Date.now() / 1000);
    const timestamp = parseInt(webhookTimestamp, 10);
    if (Math.abs(now - timestamp) > 300) {
      console.error("Webhook timestamp too old or too far in future");
      return new Response("Invalid timestamp", { status: 400 });
    }

    const body = await request.text();
    const secret = env.PARALLEL_API_KEY;

    // Verify signature
    const isValidSignature = await verifyWebhookSignature(
      body,
      secret,
      webhookSignature,
      webhookId,
      webhookTimestamp
    );

    if (!isValidSignature) {
      console.error("Invalid webhook signature");
      return new Response("Invalid signature", { status: 401 });
    }

    const payload: WebhookPayload = JSON.parse(body);

    // Handle task run status events
    if (payload.type === "task_run.status") {
      const { data } = payload;
      const taskSlug = data.metadata?.task_slug;
      if (!taskSlug) {
        console.error("No task_slug in webhook metadata");
        return new Response("OK", { status: 200 }); // Still return 200 to acknowledge
      }

      const task = TASKS.find((t) => t.slug === taskSlug);
      if (!task) {
        console.error(`Task not found for slug: ${taskSlug}`);
        return new Response("OK", { status: 200 }); // Still return 200 to acknowledge
      }

      if (data.status === "completed") {
        // Get the full result from the API
        try {
          const resultResponse = await fetch(
            `https://api.parallel.ai/v1/tasks/runs/${data.run_id}/result`,
            {
              headers: {
                "x-api-key": env.PARALLEL_API_KEY,
              },
            }
          );

          if (resultResponse.ok) {
            const resultData = await resultResponse.json();

            const taskResult: TaskResult = {
              task,
              result: resultData.output?.content || resultData,
              lastUpdated: new Date().toISOString(),
              status: "completed",
            };

            await env.TASK_RESULTS.put(taskSlug, JSON.stringify(taskResult));
            console.log(
              `Successfully stored result for task: ${taskSlug}`,
              taskResult
            );
          } else {
            console.error(
              `Failed to fetch result for run ${data.run_id}:`,
              await resultResponse.text()
            );
          }
        } catch (error) {
          console.error(`Error fetching result for run ${data.run_id}:`, error);
        }
      } else if (data.status === "failed") {
        // Store failed result
        const taskResult: TaskResult = {
          task,
          result: null,
          lastUpdated: new Date().toISOString(),
          status: "failed",
          error: data.error?.message || "Task execution failed",
        };

        await env.TASK_RESULTS.put(taskSlug, JSON.stringify(taskResult));
        console.log(`Stored failed result for task: ${taskSlug}`);
      }
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

async function runAllTasks(env: Env): Promise<void> {
  const webhookUrl = env.WEBHOOK_URL;

  console.log("Starting to run all tasks");

  for (const task of TASKS) {
    try {
      const requestBody = {
        task_spec: task.task_spec,
        input: task.input,
        processor: task.processor,
        metadata: {
          task_slug: task.slug,
        },
        webhook: {
          url: webhookUrl,
          event_types: ["task_run.status"],
          ...(env.PARALLEL_API_KEY && { secret: env.PARALLEL_API_KEY }),
        },
      };

      const response = await fetch(
        "https://api.parallel.ai/v1beta/tasks/runs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.PARALLEL_API_KEY,
          },
          body: JSON.stringify(requestBody),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `Failed to start task ${task.slug}:`,
          response.status,
          errorText
        );
      } else {
        const result = await response.json();
        console.log(
          `Successfully started task ${task.slug} with run ID: ${result.run_id}`
        );
      }
    } catch (error) {
      console.error(`Error starting task ${task.slug}:`, error);
    }
  }

  console.log("Finished triggering all tasks");
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
                <div class="flex items-center gap-2">
                    <span class="px-2 py-1 text-xs rounded-full ${
                      taskResult.status === "completed"
                        ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                        : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                    }">
                        ${taskResult.status}
                    </span>
                    <span class="text-sm text-gray-500 dark:text-gray-400">
                        Updated: ${new Date(
                          taskResult.lastUpdated
                        ).toLocaleDateString()}
                    </span>
                </div>
            </div>
            
            ${
              taskResult.status === "completed" && taskResult.result
                ? Object.entries(taskResult.result)
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
                    .join("")
                : taskResult.status === "failed"
                ? `
                <div class="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                    <p class="text-red-800 dark:text-red-200 font-medium">Task failed</p>
                    ${
                      taskResult.error
                        ? `<p class="text-red-700 dark:text-red-300 mt-1">${taskResult.error}</p>`
                        : ""
                    }
                </div>
              `
                : '<p class="text-gray-500 dark:text-gray-400">No results available.</p>'
            }
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
    try {
      const stored = await env.TASK_RESULTS.get<TaskResult>(task.slug, "json");
      if (stored) {
        results[task.slug] = stored;
      }
    } catch (error) {
      console.error(`Error parsing result for ${task.slug}:`, error);
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
                            <div class="flex items-center gap-2 mb-2">
                                <span class="px-2 py-1 text-xs rounded-full ${
                                  result.status === "completed"
                                    ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                                    : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                                }">
                                    ${result.status}
                                </span>
                                <div class="text-xs text-gray-500 dark:text-gray-400">
                                    ${new Date(
                                      result.lastUpdated
                                    ).toLocaleDateString()}
                                </div>
                            </div>
                            ${
                              result.status === "completed" && result.result
                                ? `<div class="text-sm text-gray-700 dark:text-gray-300">
                                  ${
                                    Object.values(result.result)[0]
                                      ? String(
                                          Object.values(result.result)[0]
                                        ).substring(0, 150) + "..."
                                      : "Results available"
                                  }
                                 </div>`
                                : result.status === "failed"
                                ? `<div class="text-sm text-red-600 dark:text-red-400">
                                   ${result.error || "Task execution failed"}
                                 </div>`
                                : ""
                            }
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
