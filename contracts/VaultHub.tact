import "@stdlib/deploy";

// ── Op codes ──
const OP_CONNECT_VAULT: Int = 0x434F4E56;     // 'CONV'
const OP_DISCONNECT_VAULT: Int = 0x44495343;   // 'DISC'
const OP_APPLY_REPORT: Int = 0x41505254;       // 'APRT'
const OP_VAULT_REGISTERED: Int = 0x56524547;   // 'VREG'
const OP_UPDATE_CONNECTION: Int = 0x55504443;   // 'UPDC'

// ── Error codes ──
const E_HUB_UNAUTHORIZED: Int = 200;
const E_HUB_ALREADY_CONNECTED: Int = 201;
const E_HUB_NOT_CONNECTED: Int = 202;
const E_HUB_ZERO_ADDRESS: Int = 203;
const E_HUB_INVALID_SHARE_LIMIT: Int = 204;
const E_HUB_REPLAY: Int = 205;
const E_HUB_PAUSED: Int = 206;
const E_HUB_INVALID_RESERVE_RATIO: Int = 207;
const E_HUB_NOT_FACTORY: Int = 208;

const TOTAL_BASIS_POINTS: Int = 10000;
const CONNECT_DEPOSIT: Int = 1000000000; // 1 TON

// ── Messages ──

message(0x434F4E56) ConnectVault {
    queryId: Int as uint64;
    vault: Address;
    shareLimit: Int as coins;
    reserveRatioBP: Int as uint16;
    infraFeeBP: Int as uint16;
    liquidityFeeBP: Int as uint16;
}

message(0x44495343) DisconnectVault {
    queryId: Int as uint64;
    vault: Address;
}

message(0x56524547) VaultRegistered {
    queryId: Int as uint64;
    vault: Address;
    success: Bool;
}

message(0x41505254) ApplyVaultReport {
    queryId: Int as uint64;
    vault: Address;
    totalValue: Int as coins;
    inOutDelta: Int as int257;
}

message(0x55504443) UpdateConnection {
    queryId: Int as uint64;
    vault: Address;
    shareLimit: Int as coins;
    reserveRatioBP: Int as uint16;
    infraFeeBP: Int as uint16;
}

message(0x53544643) SetFactory {
    factory: Address;
}

message(0x46435452) FactoryRegistration {
    queryId: Int as uint64;
    vault: Address;
    owner: Address;
    shareLimit: Int as coins;
    reserveRatioBP: Int as uint16;
    infraFeeBP: Int as uint16;
    liquidityFeeBP: Int as uint16;
}

struct VaultRecord {
    owner: Address;
    connected: Bool;
    shareLimit: Int as coins;
    liabilityShares: Int as coins;
    totalValue: Int as coins;
    inOutDelta: Int;
    reserveRatioBP: Int as uint16;
    infraFeeBP: Int as uint16;
    liquidityFeeBP: Int as uint16;
    reportTimestamp: Int as uint48;
}

contract VaultHub with Deployable {
    admin: Address;
    factory: Address;
    oracleAddress: Address;
    paused: Bool;
    vaultCount: Int as uint32;
    vaultRecords: map<Address, VaultRecord>;
    vaultByIndex: map<Int, Address>;
    processedQueries: map<Int, Bool>;

    init(admin: Address, factory: Address, oracleAddress: Address) {
        self.admin = admin;
        self.factory = factory;
        self.oracleAddress = oracleAddress;
        self.paused = false;
        self.vaultCount = 0;
    }

    // Factory registration path — called by VaultFactory after deploying a vault
    receive(msg: FactoryRegistration) {
        if (!(sender() == self.factory)) { throw(E_HUB_NOT_FACTORY); }
        self.consumeQuery(msg.queryId);
        if (!(!self.paused)) { throw(E_HUB_PAUSED); }

        let existing = self.vaultRecords.get(msg.vault);
        if (!(existing == null)) { throw(E_HUB_ALREADY_CONNECTED); }

        let record = VaultRecord{
            owner: msg.owner,
            connected: true,
            shareLimit: msg.shareLimit,
            liabilityShares: 0,
            totalValue: 0,
            inOutDelta: 0,
            reserveRatioBP: msg.reserveRatioBP,
            infraFeeBP: msg.infraFeeBP,
            liquidityFeeBP: msg.liquidityFeeBP,
            reportTimestamp: 0
        };
        self.vaultRecords.set(msg.vault, record);
        self.vaultByIndex.set(self.vaultCount, msg.vault);
        self.vaultCount = self.vaultCount + 1;

        // Acknowledge back to factory
        send(SendParameters{
            to: sender(),
            value: 0,
            mode: 64, // carry remaining gas
            body: VaultRegistered{ queryId: msg.queryId, vault: msg.vault, success: true }.toCell()
        });
    }

    // Direct admin connect
    receive(msg: ConnectVault) {
        self.requireAdmin();
        self.consumeQuery(msg.queryId);
        if (!(!self.paused)) { throw(E_HUB_PAUSED); }
        if (!(msg.shareLimit > 0)) { throw(E_HUB_INVALID_SHARE_LIMIT); }
        if (!(msg.reserveRatioBP <= TOTAL_BASIS_POINTS)) { throw(E_HUB_INVALID_RESERVE_RATIO); }

        let existing = self.vaultRecords.get(msg.vault);
        if (!(existing == null)) { throw(E_HUB_ALREADY_CONNECTED); }

        let record = VaultRecord{
            owner: sender(),
            connected: true,
            shareLimit: msg.shareLimit,
            liabilityShares: 0,
            totalValue: 0,
            inOutDelta: 0,
            reserveRatioBP: msg.reserveRatioBP,
            infraFeeBP: msg.infraFeeBP,
            liquidityFeeBP: msg.liquidityFeeBP,
            reportTimestamp: 0
        };
        self.vaultRecords.set(msg.vault, record);
        self.vaultByIndex.set(self.vaultCount, msg.vault);
        self.vaultCount = self.vaultCount + 1;
    }

    receive(msg: DisconnectVault) {
        self.requireAdmin();
        self.consumeQuery(msg.queryId);

        let existing = self.vaultRecords.get(msg.vault);
        if (!(existing != null)) { throw(E_HUB_NOT_CONNECTED); }

        self.vaultRecords.set(msg.vault, null);
        // Note: index gaps are acceptable; use vaultCount as high-water mark
    }

    receive(msg: UpdateConnection) {
        self.requireAdmin();
        self.consumeQuery(msg.queryId);

        let existing = self.vaultRecords.get(msg.vault);
        if (!(existing != null)) { throw(E_HUB_NOT_CONNECTED); }
        let record = existing!!;
        if (!(record.connected)) { throw(E_HUB_NOT_CONNECTED); }

        let updated = VaultRecord{
            owner: record.owner,
            connected: true,
            shareLimit: msg.shareLimit,
            liabilityShares: record.liabilityShares,
            totalValue: record.totalValue,
            inOutDelta: record.inOutDelta,
            reserveRatioBP: msg.reserveRatioBP,
            infraFeeBP: msg.infraFeeBP,
            liquidityFeeBP: record.liquidityFeeBP,
            reportTimestamp: record.reportTimestamp
        };
        self.vaultRecords.set(msg.vault, updated);
    }

    receive(msg: ApplyVaultReport) {
        if (!(sender() == self.oracleAddress)) { throw(E_HUB_UNAUTHORIZED); }
        self.consumeQuery(msg.queryId);

        let existing = self.vaultRecords.get(msg.vault);
        if (!(existing != null)) { throw(E_HUB_NOT_CONNECTED); }
        let record = existing!!;

        let updated = VaultRecord{
            owner: record.owner,
            connected: record.connected,
            shareLimit: record.shareLimit,
            liabilityShares: record.liabilityShares,
            totalValue: msg.totalValue,
            inOutDelta: msg.inOutDelta,
            reserveRatioBP: record.reserveRatioBP,
            infraFeeBP: record.infraFeeBP,
            liquidityFeeBP: record.liquidityFeeBP,
            reportTimestamp: now()
        };
        self.vaultRecords.set(msg.vault, updated);
    }

    // Admin can update the factory address (needed for deploy sequencing)
    receive(msg: SetFactory) {
        self.requireAdmin();
        self.factory = msg.factory;
    }

    receive("pause") {
        self.requireAdmin();
        self.paused = true;
    }

    receive("resume") {
        self.requireAdmin();
        self.paused = false;
    }

    // Bounce handling for factory registration
    bounced(msg: bounced<FactoryRegistration>) {
        // Factory registration bounced — no state to revert since we haven't stored yet
    }

    // ── Getters ──

    get fun get_admin(): Address { return self.admin; }
    get fun get_factory(): Address { return self.factory; }
    get fun get_paused(): Bool { return self.paused; }
    get fun get_vault_count(): Int { return self.vaultCount; }
    get fun get_connect_deposit(): Int { return CONNECT_DEPOSIT; }

    get fun get_vault_record(vault: Address): VaultRecord? {
        return self.vaultRecords.get(vault);
    }

    get fun is_vault_connected(vault: Address): Bool {
        let record = self.vaultRecords.get(vault);
        if (record == null) { return false; }
        return record!!.connected;
    }

    get fun get_vault_by_index(index: Int): Address? {
        return self.vaultByIndex.get(index);
    }

    get fun get_query_processed(queryId: Int): Bool {
        return self.processedQueries.get(queryId) != null;
    }

    // ── Internal ──

    fun requireAdmin() {
        if (!(sender() == self.admin)) { throw(E_HUB_UNAUTHORIZED); }
    }

    fun consumeQuery(queryId: Int) {
        if (!(queryId > 0)) { throw(E_HUB_ZERO_ADDRESS); }
        if (!(self.processedQueries.get(queryId) == null)) { throw(E_HUB_REPLAY); }
        self.processedQueries.set(queryId, true);
    }
}
