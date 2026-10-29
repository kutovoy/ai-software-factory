# Spec Delta

## Purpose

Defines the append-only event log and its SSE projection, so the UI and future scorers consume one
consistent stream.

## ADDED Requirements

### Requirement: Append-only log

Every run SHALL have an append-only JSONL event log, and the same events SHALL be indexed in Postgres with
`runId`, `seq`, `type`, `ts`, and payload.

#### Scenario: Append
- **WHEN** an adapter emits an event
- **THEN** it is appended to `runs/<runId>/events.jsonl`
- **AND** inserted into the `events` table with the next `seq`

#### Scenario: Immutability
- **WHEN** an event has been written
- **THEN** it is never updated or deleted
- **AND** corrections are expressed as new events

### Requirement: SSE streaming with replay

The API SHALL expose `GET /runs/:id/events` as Server-Sent Events, supporting replay from `Last-Event-ID`
and live tailing.

#### Scenario: Live tail
- **WHEN** a client connects to a running run
- **THEN** it receives events as they are appended
- **AND** each event's SSE `id` equals its `seq`

#### Scenario: Replay
- **WHEN** a client reconnects with `Last-Event-ID: 42`
- **THEN** it receives events with `seq > 42`
- **AND** no duplicates or gaps

#### Scenario: Terminal close
- **WHEN** the run reaches a terminal state
- **THEN** the stream emits the terminal event and closes

### Requirement: Read model

Postgres SHALL provide queryable `runs`, `run_steps`, and `events` tables sufficient to render run lists,
run detail, and cost/usage summaries without calling Temporal.

#### Scenario: Run list
- **WHEN** `GET /runs` is called
- **THEN** runs are returned newest-first with `status`, `factory`, `definitionCommit`, `startedAt`,
  `endedAt`, and `costUsd`

#### Scenario: Run detail
- **WHEN** `GET /runs/:id` is called
- **THEN** it returns the run, its steps, and artifact references
- **AND** 404 with `run_not_found` for unknown ids
