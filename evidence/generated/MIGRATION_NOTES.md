# Migration Notes: VaultFactory

- **Source:** solidity
- **Target:** tact
- **Complexity:** low

## Key Differences

TON smart contracts differ fundamentally from solidity:

1. **Asynchronous messaging** — All contract-to-contract calls are async via messages
2. **Cell-based storage** — Data is stored in a tree of cells, not key-value slots
3. **Actor model** — Each contract is an independent actor with its own state
4. **No shared state** — Contracts cannot read each other's storage directly

## Feature Mapping

| Source | TON Equivalent | Notes |
|--------|---------------|-------|
| mapping(address => uint) | Dictionary (HashmapE) | Use 256-bit keys for addresses |
| msg.sender | sender_address (from msg) | Parse from incoming internal message |
| msg.value | msg_value (from msg) | Available in message context |
| require() | throw_unless() | Custom exit codes instead of strings |
| modifier | inline function checks | No modifier syntax; use helper functions |
| event | External messages / logs | Use outgoing messages or external message logs |
| ERC-20 | TEP-74 (Jetton) | Different architecture: master + wallet contracts |
| ERC-721 | TEP-62 (NFT) | Collection + individual item contracts |
| inheritance | No inheritance | Use composition. Each contract is standalone. |
| try/catch | TRYARGS/TRY opcodes | Available in TVM but used differently |

## Warnings

- ⚠ TON has no inheritance — use composition

## Next Steps

1. Review the generated scaffold code
2. Implement actual business logic
3. Write tests: `ton-dev test-gen VaultFactory.tact`
4. Audit: `ton-dev audit VaultFactory.tact`
5. Deploy to testnet: `ton-dev deploy build/VaultFactory.boc --network testnet`
