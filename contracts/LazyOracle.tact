import "@stdlib/deploy";

// ── Error codes ──
const E_ORACLE_UNAUTHORIZED: Int = 600;
const E_ORACLE_REPLAY: Int = 601;
const E_ORACLE_STALE_REPORT: Int = 602;
const E_ORACLE_INVALID_PROOF: Int = 603;

// ── Messages ──

message(0x4F525054) SubmitReport {
    queryId: Int as uint64;
    vault: Address;
    totalValue: Int as coins;
    inOutDelta: Int as int257;
    timestamp: Int as uint48;
}

message(0x4F554244) UpdateTreeRoot {
    queryId: Int as uint64;
    treeRoot: Int as uint256;
    timestamp: Int as uint48;
}

message(0x4F53514E) SetQuarantinePeriod {
    queryId: Int as uint64;
    period: Int as uint64;
}

message(0x4F534D52) SetMaxRewardRatioBP {
    queryId: Int as uint64;
    maxRewardRatioBP: Int as uint16;
}

struct VaultReport {
    totalValue: Int as coins;
    inOutDelta: Int;
    timestamp: Int as uint48;
    quarantineUntil: Int as uint48;
}

contract LazyOracle with Deployable {
    admin: Address;
    reporter: Address;   // Authorized oracle reporter
    vaultHub: Address;

    treeRoot: Int as uint256;
    treeTimestamp: Int as uint48;
    quarantinePeriod: Int as uint64;
    maxRewardRatioBP: Int as uint16;

    vaultReports: map<Address, VaultReport>;
    processedQueries: map<Int, Bool>;

    init(admin: Address, reporter: Address, vaultHub: Address) {
        self.admin = admin;
        self.reporter = reporter;
        self.vaultHub = vaultHub;
        self.treeRoot = 0;
        self.treeTimestamp = 0;
        self.quarantinePeriod = 172800; // 2 days default
        self.maxRewardRatioBP = 500; // 5% max reward ratio
    }

    receive(msg: SubmitReport) {
        if (!(sender() == self.reporter)) { throw(E_ORACLE_UNAUTHORIZED); }
        self.consumeQuery(msg.queryId);
        if (!(msg.timestamp > 0)) { throw(E_ORACLE_STALE_REPORT); }

        // Check if value jump needs quarantine
        let existing = self.vaultReports.get(msg.vault);
        let quarantineUntil: Int = 0;

        if (existing != null) {
            let prev = existing!!;
            let valueDiff = msg.totalValue - prev.totalValue;
            let deltaDiff = msg.inOutDelta - prev.inOutDelta;
            let unexplainedGrowth = valueDiff - deltaDiff;

            // If unexplained growth exceeds max reward ratio, quarantine it
            if (prev.totalValue > 0 && unexplainedGrowth > 0) {
                let maxReward = prev.totalValue * self.maxRewardRatioBP / 10000;
                if (unexplainedGrowth > maxReward) {
                    quarantineUntil = now() + self.quarantinePeriod;
                }
            }
        }

        self.vaultReports.set(msg.vault, VaultReport{
            totalValue: msg.totalValue,
            inOutDelta: msg.inOutDelta,
            timestamp: msg.timestamp,
            quarantineUntil: quarantineUntil
        });
    }

    receive(msg: UpdateTreeRoot) {
        if (!(sender() == self.reporter)) { throw(E_ORACLE_UNAUTHORIZED); }
        self.consumeQuery(msg.queryId);
        self.treeRoot = msg.treeRoot;
        self.treeTimestamp = msg.timestamp;
    }

    receive(msg: SetQuarantinePeriod) {
        self.requireAdmin();
        self.consumeQuery(msg.queryId);
        self.quarantinePeriod = msg.period;
    }

    receive(msg: SetMaxRewardRatioBP) {
        self.requireAdmin();
        self.consumeQuery(msg.queryId);
        if (!(msg.maxRewardRatioBP <= 10000)) { throw(E_ORACLE_UNAUTHORIZED); }
        self.maxRewardRatioBP = msg.maxRewardRatioBP;
    }

    // ── Getters ──

    get fun get_admin(): Address { return self.admin; }
    get fun get_reporter(): Address { return self.reporter; }
    get fun get_tree_root(): Int { return self.treeRoot; }
    get fun get_tree_timestamp(): Int { return self.treeTimestamp; }
    get fun get_quarantine_period(): Int { return self.quarantinePeriod; }
    get fun get_max_reward_ratio_bp(): Int { return self.maxRewardRatioBP; }

    get fun get_vault_report(vault: Address): VaultReport? {
        return self.vaultReports.get(vault);
    }

    get fun is_report_fresh(vault: Address): Bool {
        let report = self.vaultReports.get(vault);
        if (report == null) { return false; }
        let r = report!!;
        return (now() - r.timestamp) < 172800; // 2 days
    }

    get fun is_quarantined(vault: Address): Bool {
        let report = self.vaultReports.get(vault);
        if (report == null) { return false; }
        return report!!.quarantineUntil > now();
    }

    get fun get_query_processed(queryId: Int): Bool {
        return self.processedQueries.get(queryId) != null;
    }

    // ── Internal ──

    fun requireAdmin() {
        if (!(sender() == self.admin)) { throw(E_ORACLE_UNAUTHORIZED); }
    }

    fun consumeQuery(queryId: Int) {
        if (!(queryId > 0)) { throw(E_ORACLE_STALE_REPORT); }
        if (!(self.processedQueries.get(queryId) == null)) { throw(E_ORACLE_REPLAY); }
        self.processedQueries.set(queryId, true);
    }
}
