# Lido EVM → TVM Migration — Final Report

## Status: ✅ Full Protocol Suite Migrated

**Date:** 2026-02-23
**Platform:** TON/TVM via Tact language
**Total Contracts:** 8 (compiled to BOC)
**Total Tests:** 29 (all passing)

---

## Contracts Migrated

### Phase 1 — Core Vault (Complete)
| Contract | Source (Solidity) | Tact File | BOC | Tests |
|---|---|---|---|---|
| StakingVault | `StakingVault.sol` | `contracts/StakingVault.tact` | ✅ | 9 |
| UpgradeController | N/A (TVM-native) | `contracts/UpgradeController.tact` | ✅ | (via StakingVault tests) |
| WithdrawalAdapterStub | N/A (test stub) | `contracts/WithdrawalAdapterStub.tact` | ✅ | (via StakingVault tests) |

### Phase 2 — Full Protocol Suite (Complete)
| Contract | Source (Solidity) | Tact File | BOC | Tests |
|---|---|---|---|---|
| VaultHub | `VaultHub.sol` (1,769 lines) | `contracts/VaultHub.tact` | ✅ | 8 |
| VaultFactory | `VaultFactory.sol` (184 lines) | `contracts/VaultFactory.tact` | ✅ | 3 |
| Dashboard | `Dashboard.sol` (827 lines) | `contracts/Dashboard.tact` | ✅ | 5 |
| OperatorGrid | `OperatorGrid.sol` (904 lines) | `contracts/OperatorGrid.tact` | ✅ | 3 |
| LazyOracle | `LazyOracle.sol` (685 lines) | `contracts/LazyOracle.tact` | ✅ | 3 |

---

## Cross-Contract Flows Demonstrated

### Primary Flow: VaultFactory → VaultHub Registration
```
User → VaultFactory.CreateVault()
  → deploys StakingVault (with code+data in message)
  → sends FactoryRegistration to VaultHub
  → VaultHub stores vault record, acknowledges
  → VaultFactory receives VaultRegistered confirmation
```

### Secondary Flows:
- **Dashboard → StakingVault**: Role-based fund/withdraw/pause/resume forwarding
- **Admin → VaultHub**: Direct connect/disconnect/update/pause/resume
- **Registry → OperatorGrid**: Tier management, vault registration, jail/unjail
- **Reporter → LazyOracle**: Vault report submission with quarantine detection
- **Full lifecycle**: Factory deploy → Hub registration → Dashboard management → Grid registration → Oracle reporting

---

## TVM Adaptation Patterns Applied

| EVM Pattern | TVM Adaptation |
|---|---|
| `mapping(address => struct)` | `map<Address, Struct>` |
| Modifiers (`onlyOwner`) | `if (!(cond)) { throw(code); }` |
| `require(cond, "msg")` | `if (!(cond)) { throw(errorCode); }` |
| Synchronous cross-contract calls | Async message sends with bounce handlers |
| Proxy/Clone patterns | `initOf` + `contractAddress()` for deterministic deploys |
| Events | State changes readable by indexers |
| `msg.value` forwarding | Explicit value allocation per outbound message |
| Access control roles | Bitmask-based role system (`map<Address, Int>`) |
| Replay protection | `processedQueries: map<Int, Bool>` per contract |
| Upgradeable proxies | `set_code` with authorization gate |

### Key TVM-Specific Considerations
1. **Message value budgeting**: Each outbound message needs explicit TON allocation. The vault deploy message (carrying code+data) requires ~0.5 TON for forward fees due to cell count.
2. **Circular deployment**: VaultHub↔VaultFactory circular references resolved via `SetFactory` admin message post-deployment.
3. **Bounce handling**: `bounced<MessageType>` for typed bounce receivers; critical for fee refund paths.
4. **Action phase limits**: Total outbound message size affects action phase success; mode 64 (carry remaining) can fail if prior sends consume too much.

---

## Test Coverage Summary

### `tests/stakingvault.test.ts` — 9 tests
- Owner operations (fund, withdraw, set depositor, set fee)
- Access control enforcement
- Deposit gating (pause/resume)
- Withdrawal adapter integration (async send + bounce refund)
- Replay protection
- Upgrade authorization + ossification

### `tests/cross-contract.test.ts` — 20 tests
- Factory→Hub vault creation and registration (3 tests)
- VaultHub admin operations: connect, disconnect, pause, update (5 tests)
- OperatorGrid tier/vault management (3 tests)
- LazyOracle report submission and access control (3 tests)
- Dashboard role-based access and forwarding (4 tests)
- **Full end-to-end lifecycle** (1 test covering all contracts)
- Connection parameter updates (1 test)

---

## Build Artifacts

All contracts compile to BOC in `build/`:
```
build/staking_vault/staking_vault_StakingVault.code.boc
build/upgrade_controller/upgrade_controller_UpgradeController.code.boc
build/withdrawal_adapter_stub/withdrawal_adapter_stub_WithdrawalAdapterStub.code.boc
build/vault_hub/vault_hub_VaultHub.code.boc
build/vault_factory/vault_factory_VaultFactory.code.boc
build/dashboard/dashboard_Dashboard.code.boc
build/operator_grid/operator_grid_OperatorGrid.code.boc
build/lazy_oracle/lazy_oracle_LazyOracle.code.boc
```

## What's Not Migrated (Out of Scope)
- `Permissions.sol` → Integrated directly into Dashboard as bitmask roles
- `NodeOperatorFee.sol` → Simplified into Dashboard's fee management
- stETH/wstETH token interactions (no equivalent on TON)
- Merkle proof verification in LazyOracle (simplified to direct reporting)
- PredepositGuarantee integration
- Confirmable2Addresses pattern from OperatorGrid
