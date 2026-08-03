# Repository Guidelines

## Project Structure & Content Organization

This repository contains the product-start document and runnable prototype for **AI Learning OS**, an AI-native personal learning system. The primary brief is [`AI School.md`](./AI%20School.md). Product decisions and the active backlog live in `docs/`; the React client lives in `src/`; the local API, Agents, and model adapters live in `server/`. Tests are colocated with their modules.

Keep future materials organized by purpose rather than mixing drafts into the root. Suggested paths are `docs/` for product and technical documentation, `src/` for application code, `tests/` for automated tests, and `assets/` for images or diagrams. Update this guide when that structure becomes real.

## Development, Build, and Test Commands

The project uses Node.js, Vite, React, TypeScript, and Vitest. Canonical commands are:

```sh
npm run dev     # start the web client and local Agent API in watch mode
npm start       # start the web client and Agent API, then open a browser
npm run dev:web # start only the Vite web client
npm run dev:api # start only the local Agent API
npm test        # run automated tests once
npm run build   # type-check and create a production build
npm run check   # run all required validation
```

## Documentation Style & Naming

Use clear Markdown headings with a single `#` title followed by logically nested `##` and `###` sections. Keep product claims concrete, use short paragraphs and lists, and preserve the existing Chinese language unless a document is explicitly intended for an English-speaking audience. Use fenced code blocks for workflows, prompts, or structured examples.

Name documents descriptively with kebab-case where practical, such as `docs/learning-planner-agent.md`. Use stable terminology: “AI Learning OS,” “Planner Agent,” “Teacher Agent,” “Coach Agent,” and “Evaluator Agent.”

## Testing and Review

For documentation-only changes, verify heading hierarchy, link targets, code-fence balance, and terminology consistency. For future code, place tests beside the relevant module or in `tests/`, name them after the behavior they cover (for example, `planner-generates-daily-tasks.test.ts`), and ensure the full test suite passes before review.

## Delivery, Escalation, and Production Readiness

Treat this project as a production-bound commercial product, not a disposable prototype. For implementation and architecture decisions, consider authentication and authorization, tenant isolation, privacy, observability, backup and recovery, backward-compatible migrations, rollback, capacity, cost, accessibility, and operational ownership. Record material tradeoffs or deferred production risks in `docs/`.

Updates merged or pushed to `main` are expected to reach the dev environment through the repository's automatic deployment path. Do not claim deployment from a successful build alone: verify the deployed commit, service state, and `/api/health`. Routine successful deployments do not require a user notification.

If work is blocked, requires credentials or external access, presents a material product/security/cost tradeoff, or needs an owner decision, notify the project owner through the connected Gmail account with `to: "me"`. Include the blocked outcome, evidence already gathered, impact, the smallest decision or action needed, and a safe default recommendation. Do not email routine progress or successful deployment status. Also report the blocker in the active Codex task; email supplements rather than replaces the task record.

## Commits & Pull Requests

Git history is not available in this workspace, so no existing commit convention can be inferred. Use concise imperative commits such as `docs: clarify evaluator agent scope` or `feat: add learning-plan generator`.

Pull requests should state the goal, summarize changed files, note validation performed, and link related issues or product decisions. Include screenshots for UI changes and call out any new configuration, credentials, or migrations.
