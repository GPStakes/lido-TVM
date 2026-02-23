import "@stdlib/deploy";
import "./StakingVault";

// ── Error codes ──
const E_DASH_UNAUTHORIZED: Int = 400;
const E_DASH_REPLAY: Int = 401;
const E_DASH_NOT_CONNECTED: Int = 402;
const E_DASH_ZERO_VALUE: Int = 403;
const E_DASH_INVALID_FEE: Int = 404;

const DASH_TOTAL_BASIS_POINTS: Int = 10000;

// ── Messages ──

message(0x44465544) DashFund {
    queryId: Int as uint64;
}

message(0x44574454) DashWithdraw {
    queryId: Int as uint64;
    recipient: Address;
    amount: Int as coins;
}

message(0x44504155) DashPauseDeposits {
    queryId: Int as uint64;
}

message(0x44524553) DashResumeDeposits {
    queryId: Int as uint64;
}

message(0x44534645) DashSetFee {
    queryId: Int as uint64;
    nodeOperatorFeeBP: Int as uint16;
}

message(0x44474E54) DashGrantRole {
    queryId: Int as uint64;
    account: Address;
    role: Int as uint8;
}

message(0x44524F4C) DashRevokeRole {
    queryId: Int as uint64;
    account: Address;
    role: Int as uint8;
}

// Role constants
const ROLE_ADMIN: Int = 0;
const ROLE_FUND: Int = 1;
const ROLE_WITHDRAW: Int = 2;
const ROLE_PAUSE: Int = 3;
const ROLE_RESUME: Int = 4;
const ROLE_NODE_OPERATOR_MANAGER: Int = 5;

contract Dashboard with Deployable {
    admin: Address;
    vault: Address;
    vaultHub: Address;
    nodeOperatorManager: Address;
    nodeOperatorFeeBP: Int as uint16;
    connected: Bool;

    // Role maps: role -> account -> granted
    roleMembers: map<Address, Int>;  // address -> bitmask of roles

    processedQueries: map<Int, Bool>;

    init(admin: Address, vault: Address, vaultHub: Address, nodeOperatorManager: Address, nodeOperatorFeeBP: Int) {
        self.admin = admin;
        self.vault = vault;
        self.vaultHub = vaultHub;
        self.nodeOperatorManager = nodeOperatorManager;
        self.nodeOperatorFeeBP = nodeOperatorFeeBP;
        self.connected = false;

        // Grant admin all roles
        self.roleMembers.set(admin, 63); // all 6 role bits set
        self.roleMembers.set(nodeOperatorManager, 32); // ROLE_NODE_OPERATOR_MANAGER bit
    }

    // Fund the vault through dashboard
    receive(msg: DashFund) {
        self.requireRole(sender(), ROLE_FUND);
        self.consumeQuery(msg.queryId);
        if (!(context().value > ton("0.05"))) { throw(E_DASH_ZERO_VALUE); }

        // Forward funds to vault
        send(SendParameters{
            to: self.vault,
            value: context().value - ton("0.05"),
            bounce: true,
            body: Fund{ queryId: msg.queryId }.toCell()
        });
    }

    // Withdraw from vault through dashboard
    receive(msg: DashWithdraw) {
        self.requireRole(sender(), ROLE_WITHDRAW);
        self.consumeQuery(msg.queryId);
        if (!(msg.amount > 0)) { throw(E_DASH_ZERO_VALUE); }

        send(SendParameters{
            to: self.vault,
            value: ton("0.05"),
            bounce: true,
            body: Withdraw{ queryId: msg.queryId, recipient: msg.recipient, amount: msg.amount }.toCell()
        });
    }

    // Pause beacon deposits through dashboard
    receive(msg: DashPauseDeposits) {
        self.requireRole(sender(), ROLE_PAUSE);
        self.consumeQuery(msg.queryId);

        send(SendParameters{
            to: self.vault,
            value: ton("0.05"),
            bounce: true,
            body: PauseBeaconDeposits{ queryId: msg.queryId }.toCell()
        });
    }

    // Resume beacon deposits through dashboard
    receive(msg: DashResumeDeposits) {
        self.requireRole(sender(), ROLE_RESUME);
        self.consumeQuery(msg.queryId);

        send(SendParameters{
            to: self.vault,
            value: ton("0.05"),
            bounce: true,
            body: ResumeBeaconDeposits{ queryId: msg.queryId }.toCell()
        });
    }

    // Set node operator fee
    receive(msg: DashSetFee) {
        self.requireRole(sender(), ROLE_NODE_OPERATOR_MANAGER);
        self.consumeQuery(msg.queryId);
        if (!(msg.nodeOperatorFeeBP <= DASH_TOTAL_BASIS_POINTS)) { throw(E_DASH_INVALID_FEE); }
        self.nodeOperatorFeeBP = msg.nodeOperatorFeeBP;
    }

    // Grant a role
    receive(msg: DashGrantRole) {
        self.requireRole(sender(), ROLE_ADMIN);
        self.consumeQuery(msg.queryId);

        let current = self.roleMembers.get(msg.account);
        let bits: Int = 0;
        if (current != null) {
            bits = current!!;
        }
        bits = bits | (1 << msg.role);
        self.roleMembers.set(msg.account, bits);
    }

    // Revoke a role
    receive(msg: DashRevokeRole) {
        self.requireRole(sender(), ROLE_ADMIN);
        self.consumeQuery(msg.queryId);

        let current = self.roleMembers.get(msg.account);
        if (current != null) {
            let bits = current!! & ~(1 << msg.role);
            self.roleMembers.set(msg.account, bits);
        }
    }

    receive("connect") {
        self.requireRole(sender(), ROLE_ADMIN);
        self.connected = true;
    }

    receive("disconnect") {
        self.requireRole(sender(), ROLE_ADMIN);
        self.connected = false;
    }

    // ── Getters ──

    get fun get_admin(): Address { return self.admin; }
    get fun get_vault(): Address { return self.vault; }
    get fun get_vault_hub(): Address { return self.vaultHub; }
    get fun get_node_operator_manager(): Address { return self.nodeOperatorManager; }
    get fun get_node_operator_fee_bp(): Int { return self.nodeOperatorFeeBP; }
    get fun get_connected(): Bool { return self.connected; }

    get fun has_role(account: Address, role: Int): Bool {
        let bits = self.roleMembers.get(account);
        if (bits == null) { return false; }
        return (bits!! & (1 << role)) != 0;
    }

    get fun get_query_processed(queryId: Int): Bool {
        return self.processedQueries.get(queryId) != null;
    }

    // ── Internal ──

    fun requireRole(account: Address, role: Int) {
        let bits = self.roleMembers.get(account);
        if (bits == null) { throw(E_DASH_UNAUTHORIZED); }
        if ((bits!! & (1 << role)) == 0) { throw(E_DASH_UNAUTHORIZED); }
    }

    fun consumeQuery(queryId: Int) {
        if (!(queryId > 0)) { throw(E_DASH_ZERO_VALUE); }
        if (!(self.processedQueries.get(queryId) == null)) { throw(E_DASH_REPLAY); }
        self.processedQueries.set(queryId, true);
    }
}
