# Goal

We want to build a code-driven, real-time collaborative project management platform where humans
and AI agents can generate and update flowcharts, manage tasks and dependencies, attach comments
to specific nodes, and automatically react to changes.

## Why

Instructions handed to AI agents leave two questions open: when each piece of work will finish,
and whether the work is being done in the best order. The platform should make task relations
and the critical path visible, so work can be ordered deliberately, for example:

1. Tackle the critical path first.
2. Reach a preliminary result early and check back with the owner to confirm the direction.

[tasks.md](tasks.md) is a sample backlog modeled on a real data pipeline (58 tasks, 75 dependency
links, owner gates), to use as test data.

## Implementation suggestions

Starting points only; they can change once planning starts.

| Concern | Suggestion |
|---|---|
| Flowcharts | React Flow, for code-generated interactive flowcharts |
| Tasks, node comments, AI-agent events | Ktor + PostgreSQL |
| Real-time coworker updates | WebSockets |

## Status

Repo set up; planning and implementation not started.
