# Recurring Tasks Using cronjobs and KV

See [SPEC](SPEC.md); this spec has written 90% of the code so is a great starting point to build your own cronjob+webhooks parallel app. Just a few modifications were made afterwards.

This app is part of the [parallel cookbook](https://github.com/parallel-web/parallel-cookbook)

CHANGELOG:

- 2025-08-05: first version
- 2025-08-19: second iteration ([discuss](https://x.com/janwilmake/status/1957705885767331987))
  - ✅ daily cronjob seems broken, fix it
  - ✅ add basis confidence and citations to each property.
  - ✅ show feed per task (reverse chronologically)
  - ✅ ensure to link to the github from each page

Questions:

- How to avoid getting 'low' confidence properties? They aren't useful.
- How does the API handle things like 'today'? What is the best time in the day to run the task?
