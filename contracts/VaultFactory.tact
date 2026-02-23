import "@stdlib/deploy";
import "./StakingVault";
import "./VaultHub";

// ── Error codes ──
const E_FACTORY_UNAUTHORIZED: Int = 300;
const E_FACTORY_ZERO_ADDRESS: Int = 301;
const E_FACTORY_REPLAY: Int = 302;
const E_FACTORY_INSUFFICIENT_FUNDS: Int = 303;

// ── Messages ──

message(0x43525456) CreateVault {
    queryId: Int as uint64;
    owner: Address;
    nodeOperator: Address;
    depositor: Address;
    shareLimit: Int as coins;
    reserveRatioBP: Int as uint16;
    infraFeeBP: Int as uint16;
    liquidityFeeBP: Int as uint16;
}

message(0x56435244) VaultCreated {
    queryId: Int as uint64;
    vault: Address;
    owner: Address;
    dashboard: Address;
}

contract VaultFactory with Deployable {
    admin: Address;
    vaultHub: Address;
    upgradeController: Address;
    withdrawalAdapter: Address;
    vaultCount: Int as uint32;
    deployedVaults: map<Address, Bool>;
    processedQueries: map<Int, Bool>;

    init(admin: Address, vaultHub: Address, upgradeController: Address, withdrawalAdapter: Address) {
        self.admin = admin;
        self.vaultHub = vaultHub;
        self.upgradeController = upgradeController;
        self.withdrawalAdapter = withdrawalAdapter;
        self.vaultCount = 0;
    }

    receive(msg: CreateVault) {
        self.consumeQuery(msg.queryId);
        // Require minimum deposit for VaultHub connection
        if (!(context().value >= ton("1"))) { throw(E_FACTORY_INSUFFICIENT_FUNDS); }

        // Deploy a new StakingVault using its init state
        let vaultInit = initOf StakingVault(
            msg.owner,
            msg.nodeOperator,
            msg.depositor,
            self.upgradeController,
            self.withdrawalAdapter
        );
        let vaultAddress = contractAddress(vaultInit);

        // Deploy the vault
        send(SendParameters{
            to: vaultAddress,
            value: ton("0.5"),
            bounce: false,
            code: vaultInit.code,
            data: vaultInit.data,
            body: Deploy{ queryId: msg.queryId }.toCell()
        });

        // Record as deployed
        self.deployedVaults.set(vaultAddress, true);
        self.vaultCount = self.vaultCount + 1;

        // Register with VaultHub
        send(SendParameters{
            to: self.vaultHub,
            value: ton("0.15"),
            bounce: true,
            body: FactoryRegistration{
                queryId: msg.queryId,
                vault: vaultAddress,
                owner: msg.owner,
                shareLimit: msg.shareLimit,
                reserveRatioBP: msg.reserveRatioBP,
                infraFeeBP: msg.infraFeeBP,
                liquidityFeeBP: msg.liquidityFeeBP
            }.toCell()
        });

        // Notify caller of vault creation (send minimal value)
        send(SendParameters{
            to: sender(),
            value: ton("0.01"),
            bounce: false,
            body: VaultCreated{
                queryId: msg.queryId,
                vault: vaultAddress,
                owner: msg.owner,
                dashboard: vaultAddress
            }.toCell()
        });
    }

    // Handle VaultHub acknowledgement
    receive(msg: VaultRegistered) {
        // Only accept from VaultHub
        if (!(sender() == self.vaultHub)) { throw(E_FACTORY_UNAUTHORIZED); }
        // Registration confirmed — vault is now active in the hub
    }

    // Handle bounced factory registration (VaultHub rejected)
    bounced(msg: bounced<FactoryRegistration>) {
        // Mark vault as not properly registered
        // The vault is deployed but not connected to hub
    }

    // ── Getters ──

    get fun get_admin(): Address { return self.admin; }
    get fun get_vault_hub(): Address { return self.vaultHub; }
    get fun get_vault_count(): Int { return self.vaultCount; }

    get fun is_deployed_vault(vault: Address): Bool {
        let v = self.deployedVaults.get(vault);
        return v != null && v!!;
    }

    get fun get_vault_address(owner: Address, nodeOperator: Address, depositor: Address): Address {
        return contractAddress(initOf StakingVault(
            owner, nodeOperator, depositor,
            self.upgradeController, self.withdrawalAdapter
        ));
    }

    get fun get_query_processed(queryId: Int): Bool {
        return self.processedQueries.get(queryId) != null;
    }

    // ── Internal ──

    fun consumeQuery(queryId: Int) {
        if (!(queryId > 0)) { throw(E_FACTORY_ZERO_ADDRESS); }
        if (!(self.processedQueries.get(queryId) == null)) { throw(E_FACTORY_REPLAY); }
        self.processedQueries.set(queryId, true);
    }
}
