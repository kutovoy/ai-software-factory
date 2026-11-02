# Spec Delta

## Purpose

Factory pull requests contain the files the implement stage produced.

## ADDED Requirements

### Requirement: Applied PR content

A factory PR SHALL contain the applied implement patch, not the patch file.

#### Scenario: New site files
- **WHEN** implement adds `site/app/page.tsx`
- **THEN** the PR branch contains `site/app/page.tsx`
- **AND** it does not contain `changes/<workItemId>.patch`

#### Scenario: Missing patch
- **WHEN** the implement run has no patch
- **THEN** opening the PR fails with `patch_missing`

#### Scenario: Unapplicable patch
- **WHEN** the patch cannot be applied to the base snapshot
- **THEN** opening the PR fails with `patch_apply_failed`
