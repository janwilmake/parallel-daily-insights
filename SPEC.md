# Recurring Tasks Using cronjobs and KV

RULES:
https://uithub.com/janwilmake/gists/tree/main/named-codeblocks.md

PROMPT:

@https://docs.parallel.ai/api-reference/task-api-v1/create-task-run.md
@https://docs.parallel.ai/features/webhooks.md
@https://docs.parallel.ai/core-concepts/task-spec.md
@https://docs.parallel.ai/core-concepts/processors.md
@https://docs.parallel.ai/api-reference/task-api-v1/retrieve-task-run-result.md
@https://docs.parallel.ai/resources/warnings-and-errors.md

I want to build a full-stack application with cloudflare Specification:

Recurring Tasks Using cronjobs and KV

- 5 examples of different tasks with different configurations that look up different things online
- daily cronjob at 3AM that can also be ran by admin using /run?key=PARALLEL_API_KEY
- uses webhook callback to store result in kv. the new result every day overwrites the previous. NB: use /v1beta appropriately. use the Web Crypto API for verification.
- make result of each example available at /{slug}
- list all on homepage in simple html at /
- Uses env.PARALLEL_API_KEY

Focus on 5 examples inspired by these: https://pastebin.contextarea.com/evCgBln.md but that likely have different results every day. first, generate a JSON for this. Ensure to use the same format of schema definition as the API requires.

Stack: cloudflare typescript worker with static HTML with cdn.tailwindcss.com script for style
http://flaredream.com/system-ts.md

Styleguide: https://uithub.com/janwilmake/parallel-cookbook/blob/main/styleguide.md

<!--
# Result
https://letmeprompt.com/rules-httpsuithu-3zptty0
-->
