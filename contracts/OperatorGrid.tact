import "@stdlib/deploy";

// ── Error codes ──
const E_GRID_UNAUTHORIZED: Int = 500;
const E_GRID_REPLAY: Int = 501;
const E_GRID_TIER_EXISTS: Int = 502;
const E_GRID_TIER_NOT_FOUND: Int = 503;
const E_GRID_VAULT_NOT_REGISTERED: Int = 504;
const E_GRID_INVALID_PARAMS: Int = 505;
const E_GRID_VAULT_JAILED: Int = 506;

const GRID_TOTAL_BASIS_POINTS: Int = 10000;
const DEFAULT_TIER_ID: Int = 0;

// ── Messages ──

message(0x47435454) CreateTier {
    queryId: Int as uint64;
    tierId: Int as uint32;
    shareLimit: Int as coins;
    reserveRatioBP: Int as uint16;
    forcedRebalanceThresholdBP: Int as uint16;
    infraFeeBP: Int as uint16;
    liquidityFeeBP: Int as uint16;
    reservationFeeBP: Int as uint16;
}

message(0x47525654) RegisterVault {
    queryId: Int as uint64;
    vault: Address;
    tierId: Int as uint32;
}

message(0x474A4149) JailVault {
    queryId: Int as uint64;
    vault: Address;
}

message(0x47554E4A) UnjailVault {
    queryId: Int as uint64;
    vault: Address;
}

message(0x47555054) UpdateTier {
    queryId: Int as uint64;
    tierId: Int as uint32;
    shareLimit: Int as coins;
    reserveRatioBP: Int as uint16;
}

struct TierParams {
    shareLimit: Int as coins;
    reserveRatioBP: Int as uint16;
    forcedRebalanceThresholdBP: Int as uint16;
    infraFeeBP: Int as uint16;
    liquidityFeeBP: Int as uint16;
    reservationFeeBP: Int as uint16;
    active: Bool;
}

struct VaultRegistration {
    tierId: Int as uint32;
    jailed: Bool;
    registered: Bool;
}

contract OperatorGrid with Deployable {
    admin: Address;
    registryRole: Address;  // address with REGISTRY_ROLE

    tierCount: Int as uint32;
    tiers: map<Int, TierParams>;
    vaultRegistrations: map<Address, VaultRegistration>;
    processedQueries: map<Int, Bool>;

    init(admin: Address, registryRole: Address) {
        self.admin = admin;
        self.registryRole = registryRole;
        self.tierCount = 1;

        // Default tier (ID=0)
        self.tiers.set(DEFAULT_TIER_ID, TierParams{
            shareLimit: 0,
            reserveRatioBP: 5000, // 50%
            forcedRebalanceThresholdBP: 7500,
            infraFeeBP: 0,
            liquidityFeeBP: 0,
            reservationFeeBP: 0,
            active: true
        });
    }

    receive(msg: CreateTier) {
        self.requireAdmin();
        self.consumeQuery(msg.queryId);
        if (!(msg.reserveRatioBP <= GRID_TOTAL_BASIS_POINTS)) { throw(E_GRID_INVALID_PARAMS); }
        if (!(msg.forcedRebalanceThresholdBP <= GRID_TOTAL_BASIS_POINTS)) { throw(E_GRID_INVALID_PARAMS); }

        let existing = self.tiers.get(msg.tierId);
        if (!(existing == null)) { throw(E_GRID_TIER_EXISTS); }

        self.tiers.set(msg.tierId, TierParams{
            shareLimit: msg.shareLimit,
            reserveRatioBP: msg.reserveRatioBP,
            forcedRebalanceThresholdBP: msg.forcedRebalanceThresholdBP,
            infraFeeBP: msg.infraFeeBP,
            liquidityFeeBP: msg.liquidityFeeBP,
            reservationFeeBP: msg.reservationFeeBP,
            active: true
        });
        self.tierCount = self.tierCount + 1;
    }

    receive(msg: UpdateTier) {
        self.requireAdmin();
        self.consumeQuery(msg.queryId);

        let existing = self.tiers.get(msg.tierId);
        if (!(existing != null)) { throw(E_GRID_TIER_NOT_FOUND); }
        let tier = existing!!;

        self.tiers.set(msg.tierId, TierParams{
            shareLimit: msg.shareLimit,
            reserveRatioBP: msg.reserveRatioBP,
            forcedRebalanceThresholdBP: tier.forcedRebalanceThresholdBP,
            infraFeeBP: tier.infraFeeBP,
            liquidityFeeBP: tier.liquidityFeeBP,
            reservationFeeBP: tier.reservationFeeBP,
            active: tier.active
        });
    }

    receive(msg: RegisterVault) {
        self.requireRegistry();
        self.consumeQuery(msg.queryId);

        let tier = self.tiers.get(msg.tierId);
        if (!(tier != null)) { throw(E_GRID_TIER_NOT_FOUND); }

        self.vaultRegistrations.set(msg.vault, VaultRegistration{
            tierId: msg.tierId,
            jailed: false,
            registered: true
        });
    }

    receive(msg: JailVault) {
        self.requireAdmin();
        self.consumeQuery(msg.queryId);

        let reg = self.vaultRegistrations.get(msg.vault);
        if (!(reg != null)) { throw(E_GRID_VAULT_NOT_REGISTERED); }
        let registration = reg!!;

        self.vaultRegistrations.set(msg.vault, VaultRegistration{
            tierId: registration.tierId,
            jailed: true,
            registered: true
        });
    }

    receive(msg: UnjailVault) {
        self.requireAdmin();
        self.consumeQuery(msg.queryId);

        let reg = self.vaultRegistrations.get(msg.vault);
        if (!(reg != null)) { throw(E_GRID_VAULT_NOT_REGISTERED); }
        let registration = reg!!;

        self.vaultRegistrations.set(msg.vault, VaultRegistration{
            tierId: registration.tierId,
            jailed: false,
            registered: true
        });
    }

    // ── Getters ──

    get fun get_admin(): Address { return self.admin; }
    get fun get_tier_count(): Int { return self.tierCount; }

    get fun get_tier(tierId: Int): TierParams? {
        return self.tiers.get(tierId);
    }

    get fun get_vault_registration(vault: Address): VaultRegistration? {
        return self.vaultRegistrations.get(vault);
    }

    get fun is_vault_jailed(vault: Address): Bool {
        let reg = self.vaultRegistrations.get(vault);
        if (reg == null) { return false; }
        return reg!!.jailed;
    }

    get fun get_query_processed(queryId: Int): Bool {
        return self.processedQueries.get(queryId) != null;
    }

    // ── Internal ──

    fun requireAdmin() {
        if (!(sender() == self.admin)) { throw(E_GRID_UNAUTHORIZED); }
    }

    fun requireRegistry() {
        if (!(sender() == self.registryRole || sender() == self.admin)) { throw(E_GRID_UNAUTHORIZED); }
    }

    fun consumeQuery(queryId: Int) {
        if (!(queryId > 0)) { throw(E_GRID_INVALID_PARAMS); }
        if (!(self.processedQueries.get(queryId) == null)) { throw(E_GRID_REPLAY); }
        self.processedQueries.set(queryId, true);
    }
}
