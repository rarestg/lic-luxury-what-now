# Change Ethos

This document is our guidance for deciding what to build, fix, and improve.

## Core Belief

We optimize for meaningful progress, not activity.

We invest in changes that materially improve:

1. Core functionality
2. User experience in real workflows
3. Reliability of key paths

If a change does not clearly move one of those forward, we usually do not do it.

## What Is Worth Working On

1. Bugs that block, break, or corrupt core workflows
2. Security issues with realistic impact
3. Performance issues users actually feel on primary flows
4. UX friction that repeatedly slows or confuses users
5. Improvements that simplify operation, maintenance, or future high-value changes
6. Tests and checks that protect important behavior

## What Is Usually Not Worth Working On

1. Edge cases that are extremely unlikely and low impact
2. Pure refactors with no user, reliability, or maintainability payoff
3. Cosmetic churn with no measurable UX benefit
4. Premature optimization on non-critical paths
5. Work driven by theoretical purity instead of practical outcomes
6. Expanding scope to solve hypothetical future problems

## Decision Filter (Use Before Any Change)

Ask:

1. Does this improve a core flow or user outcome?
2. Is this problem happening now, or only in theory?
3. What is the severity and frequency?
4. What is the smallest clean change that solves it?
5. What are we not doing if we do this?

If answers are weak, defer the change.

## Non-Negotiables

Even with a focus on pragmatism, we do not ignore:

1. Security and auth correctness
2. Data integrity
3. Clear error handling on critical paths
4. Maintainable code over hacks that create future drag

## Execution Style

1. Prefer small, high-confidence, reversible changes
2. Ship improvements on core paths first
3. Keep backlog items scoped and explicitly deprioritized when low impact
4. Avoid gold-plating
5. Measure impact when possible

## Final Standard

A good change is one that users feel, operators trust, and future maintainers can understand.
