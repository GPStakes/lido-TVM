# Lido → TVM Migration Evidence Pack

Generated: 2026-02-23 via `ton-dev` CLI tooling

## Overview

This evidence pack demonstrates that the Lido V3 Vaults migration from EVM (Solidity) to TVM (Tact) was performed using the **ton-dev** migration toolkit — not hand-coded from scratch.

## 1. Migration Analysis (`ton-dev migrate analyze`)

| EVM Source Contract | Analysis Output |
|---|---|
| `StakingVault.sol` | [migrate-analyze-stakingvault.json](migrate-analyze-stakingvault.json) |
| `VaultHub.sol` | [migrate-analyze-vaulthub.json](migrate-analyze-vaulthub.json) |
| `VaultFactory.sol` | [migrate-analyze-vaultfactory.json](migrate-analyze-vaultfactory.json) |
| `OperatorGrid.sol` | [migrate-analyze-operatorgrid.json](migrate-analyze-operatorgrid.json) |
| `LazyOracle.sol` | [migrate-analyze-lazyoracle.json](migrate-analyze-lazyoracle.json) |
| `Dashboard.sol` | [migrate-analyze-dashboard.json](migrate-analyze-dashboard.json) |

Each analysis extracts: state variables, functions, access control patterns, events, modifiers, inheritance, and identifies TVM-specific migration concerns (storage layout, message-passing vs calls, etc.).

## 2. Code Generation (`ton-dev migrate generate`)

| EVM Source | Generated Tact | Generation Log |
|---|---|---|
| `StakingVault.sol` | [generated/StakingVault.tact](generated/StakingVault.tact) | [migrate-generate-stakingvault.json](migrate-generate-stakingvault.json) |
| `VaultHub.sol` | [generated/VaultHub.tact](generated/VaultHub.tact) | [migrate-generate-vaulthub.json](migrate-generate-vaulthub.json) |
| `VaultFactory.sol` | [generated/VaultFactory.tact](generated/VaultFactory.tact) | [migrate-generate-vaultfactory.json](migrate-generate-vaultfactory.json) |

Generated code served as the scaffold; final contracts in `contracts/` include manual refinements for TVM-native patterns (actor model, async messaging, BOC storage).

## 3. Security Audit (`ton-dev audit`)

| Format | File | Findings |
|---|---|---|
| JSON | [ton-dev-audit-final.json](ton-dev-audit-final.json) | **0 findings** |
| Markdown | [ton-dev-audit-final.md](ton-dev-audit-final.md) | **0 findings** |

Audit covers all 9 Tact contracts in `contracts/`.

## 4. Compilation (`npx tact`)

**Log:** [compile-all.log](compile-all.log)

All contracts compiled successfully to BOC:

| Contract | Status |
|---|---|
| StakingVault | ✅ Compiled |
| VaultHub | ✅ Compiled |
| VaultFactory | ✅ Compiled |
| StTON | ✅ Compiled |
| LazyOracle | ✅ Compiled |
| OperatorGrid | ✅ Compiled |
| Dashboard | ✅ Compiled |
| UpgradeController | ✅ Compiled |
| WithdrawalAdapterStub | ✅ Compiled |

## 5. Test Suite

**Log:** [test-run-full.log](test-run-full.log)

- **4 test suites, 54 tests — all passing**
- Covers: unit tests, access control, economics, cross-contract flows
- Runtime: ~13s on sandbox blockchain

## 6. EVM → Tact Contract Mapping

| EVM Contract (Solidity) | Tact Contract | Notes |
|---|---|---|
| `StakingVault.sol` | `staking_vault.tact` | Core vault — fund, withdraw, deposit to beacon, trigger withdrawal |
| `VaultHub.sol` | `vault_hub.tact` | Registry + economics — mint/burn shares, collateral enforcement |
| `VaultFactory.sol` | `vault_factory.tact` | Deploys vaults + registers with hub |
| `stETH` (rebasable token) | `st_ton.tact` | StTON — rebasable share token, TVM-native Jetton-like |
| `OperatorGrid.sol` | `operator_grid.tact` | Operator tier management, jail/unjail |
| `LazyOracle.sol` | `lazy_oracle.tact` | Merkle-tree oracle, reporter-gated updates |
| `Dashboard.sol` | `dashboard.tact` | Role-based vault management UI contract |
| *(new for TVM)* | `upgrade_controller.tact` | TVM-specific upgrade gating (no proxy pattern) |
| *(new for TVM)* | `withdrawal_adapter_stub.tact` | Beacon chain withdrawal adapter stub |

## Tooling Used

- **`ton-dev migrate analyze`** — Static analysis of Solidity source for migration planning
- **`ton-dev migrate generate`** — Automated Tact scaffold generation from Solidity
- **`ton-dev audit`** — Security audit of final Tact contracts
- **`npx tact`** — Tact compiler (BOC generation)
- **`npx jest`** — Test runner on `@ton/sandbox` blockchain emulator
