# AGENTS.md

Instructions for AI agents contributing to this repository.

## Before you start

1. Read the project's `README.md` to understand its purpose, tech stack, endpoints, and directory structure.
2. Explore the current codebase to build context. Do not assume the README is accurate — the code is the source of truth.
3. If you find inconsistencies between the README and the code (removed endpoints still listed, outdated environment variables, incorrect directory structure, etc.), fix the README before proceeding with your task.

## During implementation

1. Implement the requested feature or fix.
2. Follow the coding style and patterns already established in the codebase.
3. Never commit credentials, tokens, or sensitive data. Check the `.gitignore` before staging any files.

## After implementation

1. Run all repository tests, if configured, and ensure every test passes. If any test fails, fix it before proceeding.
2. Update the README to reflect your changes when applicable:
   - Add new endpoints or routes to the corresponding tables.
   - Document new environment variables (without real values).
   - Update the directory tree if the project structure changed.
   - Document new service communication points (Feign clients, RabbitMQ queues, events).
3. Remove from the README any references to features that no longer exist. The README must always reflect the current state of the project.
4. Review the `.gitignore` and verify that staged files contain only changes related to the requested implementation or fix.
