# Glubean — Playground

This is a quick playground for exploring APIs with [Glubean](https://glubean.com). Write TypeScript, run it, see every
request traced.

```bash
deno task explore
```

## What's here

| Path                        | Purpose                                         |
| --------------------------- | ----------------------------------------------- |
| `explore/api.test.ts`       | GET and POST examples — edit and run            |
| `explore/search.test.ts`    | `test.pick` — one test, multiple variations     |
| `explore/auth.test.ts`      | Multi-step auth — login, use token, get profile |
| `data/search-examples.json` | Search parameters for pick examples             |

Edit the files, change the URLs, hit play. That's it.

---

## Ready for real work?

This playground is for trying things out. When you're ready to build a real test suite — with AI writing and running
tests for you — create a full project:

```bash
mkdir my-api-tests && cd my-api-tests
glubean init
```

Choose **Best Practice** to unlock:

- **AI closed-loop** — your AI reads your API spec, writes tests, runs them via MCP, reads failures, fixes, and reruns
  until green. You review the result, not the process.
- **OpenAPI-driven** — drop your spec in `context/`, and the AI knows every endpoint, method, and schema. No guessing.
- **Multi-environment** — same tests against dev, staging, and production. Switch with one flag.
- **Data-driven tests** — generate dozens of cases from JSON, CSV, or YAML with `test.each`.
- **CI + Cloud** — Git hooks, GitHub Actions, scheduled runs, Slack alerts when something breaks.

The difference: here you write tests manually. There, the AI writes them and proves they work — before you even look.
