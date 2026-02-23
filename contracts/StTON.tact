import "@stdlib/deploy";

// ══════════════════════════════════════════════════════
// StTON — Self-contained rebasable share token
// Mirrors Lido's stETH share mechanics on TON
// ══════════════════════════════════════════════════════
//
// stETH on Ethereum uses internal "shares" with a global
// totalPooledEther / totalShares ratio that rebases all
// balances on oracle report. We replicate this exactly:
//   balance(account) = shares[account] * totalPooledTON / totalShares
//
// VaultHub is the only authorized minter/burner.
// Oracle reports update totalPooledTON to trigger rebase.

// ── Error codes ──
const E_STTON_UNAUTHORIZED: Int = 700;
const E_STTON_REPLAY: Int = 701;
const E_STTON_INSUFFICIENT_SHARES: Int = 702;
const E_STTON_ZERO_AMOUNT: Int = 703;
const E_STTON_ZERO_SHARES: Int = 704;
const E_STTON_TRANSFER_SELF: Int = 705;

// ── Messages ──

message(0x53544D54) StTONMint {
    queryId: Int as uint64;
    recipient: Address;
    shareAmount: Int as coins;
}

message(0x53544252) StTONBurn {
    queryId: Int as uint64;
    account: Address;
    shareAmount: Int as coins;
}

message(0x53545246) StTONTransferShares {
    queryId: Int as uint64;
    to: Address;
    shareAmount: Int as coins;
}

message(0x53545242) StTONRebase {
    queryId: Int as uint64;
    newTotalPooledTON: Int as coins;
}

message(0x53544150) StTONApprove {
    queryId: Int as uint64;
    spender: Address;
    shareAmount: Int as coins;
}

message(0x5354544D) StTONTransferFrom {
    queryId: Int as uint64;
    from: Address;
    to: Address;
    shareAmount: Int as coins;
}

contract StTON with Deployable {
    vaultHub: Address;        // Only VaultHub can mint/burn/rebase
    totalShares: Int as coins;
    totalPooledTON: Int as coins;

    shares: map<Address, Int>;       // account → share balance
    allowances: map<Int, Int>;       // hash(owner,spender) → share allowance
    processedQueries: map<Int, Bool>;

    init(vaultHub: Address) {
        self.vaultHub = vaultHub;
        self.totalShares = 0;
        self.totalPooledTON = 0;
    }

    // ── VaultHub-only operations ──

    receive(msg: StTONMint) {
        self.requireVaultHub();
        self.consumeQuery(msg.queryId);
        if (!(msg.shareAmount > 0)) { throw(E_STTON_ZERO_AMOUNT); }

        let current = self.shares.get(msg.recipient);
        let bal: Int = 0;
        if (current != null) { bal = current!!; }
        self.shares.set(msg.recipient, bal + msg.shareAmount);
        self.totalShares = self.totalShares + msg.shareAmount;
    }

    receive(msg: StTONBurn) {
        self.requireVaultHub();
        self.consumeQuery(msg.queryId);
        if (!(msg.shareAmount > 0)) { throw(E_STTON_ZERO_AMOUNT); }

        let current = self.shares.get(msg.account);
        let bal: Int = 0;
        if (current != null) { bal = current!!; }
        if (!(bal >= msg.shareAmount)) { throw(E_STTON_INSUFFICIENT_SHARES); }

        self.shares.set(msg.account, bal - msg.shareAmount);
        self.totalShares = self.totalShares - msg.shareAmount;
    }

    // Oracle rebase: VaultHub updates totalPooledTON after report
    receive(msg: StTONRebase) {
        self.requireVaultHub();
        self.consumeQuery(msg.queryId);
        self.totalPooledTON = msg.newTotalPooledTON;
    }

    // ── User operations ──

    receive(msg: StTONTransferShares) {
        self.consumeQuery(msg.queryId);
        if (!(msg.shareAmount > 0)) { throw(E_STTON_ZERO_AMOUNT); }
        if (!(sender() != msg.to)) { throw(E_STTON_TRANSFER_SELF); }

        let senderShares = self.shares.get(sender());
        let sBal: Int = 0;
        if (senderShares != null) { sBal = senderShares!!; }
        if (!(sBal >= msg.shareAmount)) { throw(E_STTON_INSUFFICIENT_SHARES); }

        let recipientShares = self.shares.get(msg.to);
        let rBal: Int = 0;
        if (recipientShares != null) { rBal = recipientShares!!; }

        self.shares.set(sender(), sBal - msg.shareAmount);
        self.shares.set(msg.to, rBal + msg.shareAmount);
    }

    receive(msg: StTONApprove) {
        self.consumeQuery(msg.queryId);
        let key = self.allowanceKey(sender(), msg.spender);
        self.allowances.set(key, msg.shareAmount);
    }

    receive(msg: StTONTransferFrom) {
        self.consumeQuery(msg.queryId);
        if (!(msg.shareAmount > 0)) { throw(E_STTON_ZERO_AMOUNT); }
        if (!(msg.from != msg.to)) { throw(E_STTON_TRANSFER_SELF); }

        // Check allowance
        let key = self.allowanceKey(msg.from, sender());
        let allowed = self.allowances.get(key);
        let allowedVal: Int = 0;
        if (allowed != null) { allowedVal = allowed!!; }
        if (!(allowedVal >= msg.shareAmount)) { throw(E_STTON_UNAUTHORIZED); }

        // Check balance
        let fromShares = self.shares.get(msg.from);
        let fBal: Int = 0;
        if (fromShares != null) { fBal = fromShares!!; }
        if (!(fBal >= msg.shareAmount)) { throw(E_STTON_INSUFFICIENT_SHARES); }

        let toShares = self.shares.get(msg.to);
        let tBal: Int = 0;
        if (toShares != null) { tBal = toShares!!; }

        self.shares.set(msg.from, fBal - msg.shareAmount);
        self.shares.set(msg.to, tBal + msg.shareAmount);
        self.allowances.set(key, allowedVal - msg.shareAmount);
    }

    // ── Getters ──

    get fun get_vault_hub(): Address { return self.vaultHub; }
    get fun get_total_shares(): Int { return self.totalShares; }
    get fun get_total_pooled_ton(): Int { return self.totalPooledTON; }

    get fun get_shares_of(account: Address): Int {
        let s = self.shares.get(account);
        if (s == null) { return 0; }
        return s!!;
    }

    // stETH-equivalent balance: shares * totalPooledTON / totalShares
    get fun get_balance_of(account: Address): Int {
        if (self.totalShares == 0) { return 0; }
        let s = self.shares.get(account);
        if (s == null) { return 0; }
        return s!! * self.totalPooledTON / self.totalShares;
    }

    // Convert TON amount to shares
    get fun get_shares_by_pooled_ton(tonAmount: Int): Int {
        if (self.totalPooledTON == 0) { return tonAmount; } // 1:1 before first rebase
        return tonAmount * self.totalShares / self.totalPooledTON;
    }

    // Convert shares to TON amount
    get fun get_pooled_ton_by_shares(shareAmount: Int): Int {
        if (self.totalShares == 0) { return 0; }
        return shareAmount * self.totalPooledTON / self.totalShares;
    }

    get fun get_allowance(owner: Address, spender: Address): Int {
        let key = self.allowanceKey(owner, spender);
        let a = self.allowances.get(key);
        if (a == null) { return 0; }
        return a!!;
    }

    get fun get_query_processed(queryId: Int): Bool {
        return self.processedQueries.get(queryId) != null;
    }

    // ── Internal ──

    fun requireVaultHub() {
        if (!(sender() == self.vaultHub)) { throw(E_STTON_UNAUTHORIZED); }
    }

    fun consumeQuery(queryId: Int) {
        if (!(queryId > 0)) { throw(E_STTON_ZERO_AMOUNT); }
        if (!(self.processedQueries.get(queryId) == null)) { throw(E_STTON_REPLAY); }
        self.processedQueries.set(queryId, true);
    }

    fun allowanceKey(owner: Address, spender: Address): Int {
        // Deterministic key from two addresses using cell hash
        let c = beginCell().storeAddress(owner).storeAddress(spender).endCell();
        return c.hash();
    }
}
