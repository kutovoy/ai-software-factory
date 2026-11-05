# Spec Delta

## ADDED Requirements

### Requirement: Cross-platform host metrics

The agent SHALL report CPU, memory, disk/inode, load, uptime and process metrics on Linux,
Windows and macOS, degrading missing values to zero/empty instead of failing the heartbeat.

#### Scenario: Windows metrics
- **WHEN** a Windows agent heartbeats
- **THEN** CPU, memory, logical disks, uptime and process count are reported from Windows
  performance/CIM sources
- **AND** unsupported fields are omitted rather than fabricated

#### Scenario: macOS metrics
- **WHEN** a macOS agent heartbeats
- **THEN** CPU, memory, disks/inodes, load, swap and process count are reported
- **AND** a missing `sysctl` or `df` value degrades without failing the heartbeat

### Requirement: Platform-aware preflight

The preflight command SHALL check the tools the selected platform's agent actually needs.

#### Scenario: Windows preflight
- **WHEN** the operator runs the generated Windows preflight
- **THEN** it checks PowerShell, git, Bun, free disk and optional MSBuild/dotnet
- **AND** it posts the check map to the enrollment

#### Scenario: macOS preflight
- **WHEN** the operator runs the generated macOS preflight
- **THEN** it checks git, curl, Bun, Xcode command-line tools, free disk and `sandbox-exec`
- **AND** it posts the check map to the enrollment
