# Workforce Intelligence

An internal workforce planning app that helps companies retain people by finding them opportunities in another team.

I built this around a practical need: HR and managers should be able to see who may need a new role and which teams could use their skills. Skills, location, availability and budget bring the two sides together.

## What it does

- **People looking for a role:** HR or managers can flag someone for consideration, with a reason, availability date and location preferences.
- **Teams looking for people:** capture the role, required skills, dates, capacity and salary budget.
- **Matching:** compare skills, timing, location and capacity, with salary visible only to authorized users.
- **Internal transfers:** propose a move, collect approvals and record the effective date and history.

## Built with

Next.js, React, TypeScript and PostgreSQL, with Microsoft Entra ID for sign-in. A PostgreSQL worker handles background jobs. Access is scoped by organization and operation, with separate permissions for identity and compensation.

## Get started

[Local setup](docs/SETUP.md) · [User guide](docs/USER_GUIDE.md) · [Architecture](docs/ARCHITECTURE.md)
