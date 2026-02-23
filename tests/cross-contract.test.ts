import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano, Address } from '@ton/core';
import '@ton/test-utils';

import { VaultHub } from '../build/vault_hub/vault_hub_VaultHub';
import { VaultFactory } from '../build/vault_factory/vault_factory_VaultFactory';
import { StakingVault } from '../build/vault_factory/vault_factory_StakingVault';
import { Dashboard } from '../build/dashboard/dashboard_Dashboard';
import { OperatorGrid } from '../build/operator_grid/operator_grid_OperatorGrid';
import { LazyOracle } from '../build/lazy_oracle/lazy_oracle_LazyOracle';
import { UpgradeController } from '../build/upgrade_controller/upgrade_controller_UpgradeController';
import { WithdrawalAdapterStub } from '../build/withdrawal_adapter_stub/withdrawal_adapter_stub_WithdrawalAdapterStub';

describe('Cross-contract flows', () => {
    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let owner: SandboxContract<TreasuryContract>;
    let nodeOperator: SandboxContract<TreasuryContract>;
    let depositor: SandboxContract<TreasuryContract>;
    let reporter: SandboxContract<TreasuryContract>;
    let registry: SandboxContract<TreasuryContract>;
    let randomUser: SandboxContract<TreasuryContract>;

    let vaultHub: SandboxContract<VaultHub>;
    let vaultFactory: SandboxContract<VaultFactory>;
    let upgradeController: SandboxContract<UpgradeController>;
    let withdrawalAdapter: SandboxContract<WithdrawalAdapterStub>;
    let operatorGrid: SandboxContract<OperatorGrid>;
    let lazyOracle: SandboxContract<LazyOracle>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('admin');
        owner = await blockchain.treasury('owner');
        nodeOperator = await blockchain.treasury('nodeOperator');
        depositor = await blockchain.treasury('depositor');
        reporter = await blockchain.treasury('reporter');
        registry = await blockchain.treasury('registry');
        randomUser = await blockchain.treasury('random');

        // Deploy adapter and controller
        withdrawalAdapter = blockchain.openContract(await WithdrawalAdapterStub.fromInit());
        await withdrawalAdapter.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 1n });

        upgradeController = blockchain.openContract(await UpgradeController.fromInit(admin.address));
        await upgradeController.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 2n });

        // Break circular dependency: compute factory address first, then use it for hub init
        // 1. We need hub address for factory init, and factory address for hub init
        // 2. Solution: iterate - guess hub address, compute factory, recompute hub

        // First pass: compute factory with a dummy hub to get factory address shape
        // Actually simpler: deploy hub first accepting ANY factory (use a "set factory" pattern)
        // But our contract uses init params. So let's do address pre-computation.

        // Use a fixed approach: compute both addresses simultaneously
        // Factory init needs: admin, hubAddress, upgradeController, withdrawalAdapter
        // Hub init needs: admin, factoryAddress, reporter

        // We can solve this by trying different nonces or by using a known trick:
        // Deploy hub with a placeholder factory, then deploy factory with hub address
        // The hub will accept messages from the placeholder (admin) OR the factory

        // Simple solution: make hub accept admin as factory too (already set in init)
        // Deploy hub with admin as factory
        // Deploy a dummy StTON address for VaultHub init (not used in these tests)
        const stTONDummy = await blockchain.treasury('stTONDummy');
        vaultHub = blockchain.openContract(await VaultHub.fromInit(
            admin.address, admin.address, reporter.address, stTONDummy.address
        ));
        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 3n });

        // Deploy factory pointing to hub
        vaultFactory = blockchain.openContract(await VaultFactory.fromInit(
            admin.address, vaultHub.address, upgradeController.address, withdrawalAdapter.address
        ));
        await vaultFactory.send(admin.getSender(), { value: toNano('1') }, { $$type: 'Deploy', queryId: 4n });

        // Update hub's factory reference to point to the actual factory
        await vaultHub.send(admin.getSender(), { value: toNano('0.05') }, {
            $$type: 'SetFactory',
            factory: vaultFactory.address
        });

        // Deploy OperatorGrid
        operatorGrid = blockchain.openContract(await OperatorGrid.fromInit(admin.address, registry.address));
        await operatorGrid.send(admin.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 7n });

        // Deploy LazyOracle
        lazyOracle = blockchain.openContract(await LazyOracle.fromInit(admin.address, reporter.address, vaultHub.address));
        await lazyOracle.send(admin.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 8n });
    });

    // ────────────────────────────────────
    // VaultFactory + VaultHub cross-contract
    // ────────────────────────────────────

    it('Factory creates vault and registers with VaultHub', async () => {
        const result = await vaultFactory.send(owner.getSender(), { value: toNano('2') }, {
            $$type: 'CreateVault',
            queryId: 100n,
            owner: owner.address,
            nodeOperator: nodeOperator.address,
            depositor: depositor.address,
            shareLimit: toNano('1000'),
            reserveRatioBP: 3000n,
            infraFeeBP: 100n,
            liquidityFeeBP: 50n
        });

        expect(result.transactions).toHaveTransaction({ success: true });

        // Vault should be registered in factory
        const isDeployed = await vaultFactory.getIsDeployedVault(
            await vaultFactory.getGetVaultAddress(owner.address, nodeOperator.address, depositor.address)
        );
        expect(isDeployed).toBe(true);
        expect(await vaultFactory.getGetVaultCount()).toBe(1n);
    });

    it('VaultHub receives factory registration', async () => {
        await vaultFactory.send(owner.getSender(), { value: toNano('2') }, {
            $$type: 'CreateVault',
            queryId: 101n,
            owner: owner.address,
            nodeOperator: nodeOperator.address,
            depositor: depositor.address,
            shareLimit: toNano('1000'),
            reserveRatioBP: 3000n,
            infraFeeBP: 100n,
            liquidityFeeBP: 50n
        });

        const vaultAddr = await vaultFactory.getGetVaultAddress(owner.address, nodeOperator.address, depositor.address);
        const connected = await vaultHub.getIsVaultConnected(vaultAddr);
        expect(connected).toBe(true);
        expect(await vaultHub.getGetVaultCount()).toBe(1n);
    });

    it('Factory rejects replay of same queryId', async () => {
        await vaultFactory.send(owner.getSender(), { value: toNano('2') }, {
            $$type: 'CreateVault',
            queryId: 102n,
            owner: owner.address,
            nodeOperator: nodeOperator.address,
            depositor: depositor.address,
            shareLimit: toNano('1000'),
            reserveRatioBP: 3000n,
            infraFeeBP: 100n,
            liquidityFeeBP: 50n
        });

        const result2 = await vaultFactory.send(owner.getSender(), { value: toNano('2') }, {
            $$type: 'CreateVault',
            queryId: 102n, // same queryId
            owner: owner.address,
            nodeOperator: nodeOperator.address,
            depositor: depositor.address,
            shareLimit: toNano('1000'),
            reserveRatioBP: 3000n,
            infraFeeBP: 100n,
            liquidityFeeBP: 50n
        });

        // Should have a failed transaction on the factory (replay protection)
        expect(result2.transactions).toHaveTransaction({
            to: vaultFactory.address,
            success: false,
            exitCode: 302  // E_FACTORY_REPLAY
        });
    });

    // ────────────────────────────────────
    // VaultHub direct management
    // ────────────────────────────────────

    it('Admin can directly connect a vault to VaultHub', async () => {
        const fakeVault = await blockchain.treasury('fakeVault');

        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'ConnectVault',
            queryId: 200n,
            vault: fakeVault.address,
            shareLimit: toNano('500'),
            reserveRatioBP: 5000n,
            infraFeeBP: 100n,
            liquidityFeeBP: 50n
        });

        expect(await vaultHub.getIsVaultConnected(fakeVault.address)).toBe(true);
    });

    it('Admin can disconnect a vault from VaultHub', async () => {
        const fakeVault = await blockchain.treasury('fakeVault');

        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'ConnectVault',
            queryId: 201n,
            vault: fakeVault.address,
            shareLimit: toNano('500'),
            reserveRatioBP: 5000n,
            infraFeeBP: 100n,
            liquidityFeeBP: 50n
        });

        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'DisconnectVault',
            queryId: 202n,
            vault: fakeVault.address
        });

        expect(await vaultHub.getIsVaultConnected(fakeVault.address)).toBe(false);
    });

    it('Non-admin cannot connect vault to VaultHub', async () => {
        const fakeVault = await blockchain.treasury('fakeVault');

        const result = await vaultHub.send(randomUser.getSender(), { value: toNano('0.1') }, {
            $$type: 'ConnectVault',
            queryId: 203n,
            vault: fakeVault.address,
            shareLimit: toNano('500'),
            reserveRatioBP: 5000n,
            infraFeeBP: 100n,
            liquidityFeeBP: 50n
        });

        expect(result.transactions).toHaveTransaction({
            from: randomUser.address,
            to: vaultHub.address,
            success: false
        });
    });

    it('VaultHub can be paused and resumed', async () => {
        await vaultHub.send(admin.getSender(), { value: toNano('0.05') }, "pause");
        expect(await vaultHub.getGetPaused()).toBe(true);

        await vaultHub.send(admin.getSender(), { value: toNano('0.05') }, "resume");
        expect(await vaultHub.getGetPaused()).toBe(false);
    });

    it('Cannot connect vault when VaultHub is paused', async () => {
        await vaultHub.send(admin.getSender(), { value: toNano('0.05') }, "pause");

        const fakeVault = await blockchain.treasury('fakeVault');
        const result = await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'ConnectVault',
            queryId: 204n,
            vault: fakeVault.address,
            shareLimit: toNano('500'),
            reserveRatioBP: 5000n,
            infraFeeBP: 100n,
            liquidityFeeBP: 50n
        });

        expect(result.transactions).toHaveTransaction({
            from: admin.address,
            to: vaultHub.address,
            success: false
        });
    });

    // ────────────────────────────────────
    // OperatorGrid
    // ────────────────────────────────────

    it('Admin can create a tier in OperatorGrid', async () => {
        await operatorGrid.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'CreateTier',
            queryId: 300n,
            tierId: 1n,
            shareLimit: toNano('10000'),
            reserveRatioBP: 3000n,
            forcedRebalanceThresholdBP: 7000n,
            infraFeeBP: 200n,
            liquidityFeeBP: 100n,
            reservationFeeBP: 50n
        });

        const tier = await operatorGrid.getGetTier(1n);
        expect(tier).not.toBeNull();
        expect(tier!.shareLimit).toBe(toNano('10000'));
        expect(tier!.reserveRatioBP).toBe(3000n);
    });

    it('Registry can register vault in OperatorGrid', async () => {
        // Create tier first
        await operatorGrid.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'CreateTier',
            queryId: 301n,
            tierId: 1n,
            shareLimit: toNano('10000'),
            reserveRatioBP: 3000n,
            forcedRebalanceThresholdBP: 7000n,
            infraFeeBP: 200n,
            liquidityFeeBP: 100n,
            reservationFeeBP: 50n
        });

        const fakeVault = await blockchain.treasury('gridVault');
        await operatorGrid.send(registry.getSender(), { value: toNano('0.1') }, {
            $$type: 'RegisterVault',
            queryId: 302n,
            vault: fakeVault.address,
            tierId: 1n
        });

        const reg = await operatorGrid.getGetVaultRegistration(fakeVault.address);
        expect(reg).not.toBeNull();
        expect(reg!.tierId).toBe(1n);
        expect(reg!.jailed).toBe(false);
    });

    it('Admin can jail and unjail a vault', async () => {
        await operatorGrid.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'CreateTier', queryId: 303n, tierId: 1n,
            shareLimit: toNano('10000'), reserveRatioBP: 3000n,
            forcedRebalanceThresholdBP: 7000n, infraFeeBP: 200n,
            liquidityFeeBP: 100n, reservationFeeBP: 50n
        });

        const fakeVault = await blockchain.treasury('jailVault');
        await operatorGrid.send(registry.getSender(), { value: toNano('0.1') }, {
            $$type: 'RegisterVault', queryId: 304n, vault: fakeVault.address, tierId: 1n
        });

        await operatorGrid.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'JailVault', queryId: 305n, vault: fakeVault.address
        });
        expect(await operatorGrid.getIsVaultJailed(fakeVault.address)).toBe(true);

        await operatorGrid.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'UnjailVault', queryId: 306n, vault: fakeVault.address
        });
        expect(await operatorGrid.getIsVaultJailed(fakeVault.address)).toBe(false);
    });

    // ────────────────────────────────────
    // LazyOracle
    // ────────────────────────────────────

    it('Reporter can submit vault report to LazyOracle', async () => {
        const fakeVault = await blockchain.treasury('oracleVault');

        await lazyOracle.send(reporter.getSender(), { value: toNano('0.1') }, {
            $$type: 'SubmitReport',
            queryId: 400n,
            vault: fakeVault.address,
            totalValue: toNano('100'),
            inOutDelta: toNano('50'),
            timestamp: BigInt(Math.floor(Date.now() / 1000))
        });

        const report = await lazyOracle.getGetVaultReport(fakeVault.address);
        expect(report).not.toBeNull();
        expect(report!.totalValue).toBe(toNano('100'));
    });

    it('Non-reporter cannot submit report', async () => {
        const fakeVault = await blockchain.treasury('oracleVault2');

        const result = await lazyOracle.send(randomUser.getSender(), { value: toNano('0.1') }, {
            $$type: 'SubmitReport',
            queryId: 401n,
            vault: fakeVault.address,
            totalValue: toNano('100'),
            inOutDelta: toNano('50'),
            timestamp: BigInt(Math.floor(Date.now() / 1000))
        });

        expect(result.transactions).toHaveTransaction({
            from: randomUser.address,
            to: lazyOracle.address,
            success: false
        });
    });

    it('Reporter can update tree root', async () => {
        await lazyOracle.send(reporter.getSender(), { value: toNano('0.1') }, {
            $$type: 'UpdateTreeRoot',
            queryId: 402n,
            treeRoot: 123456789n,
            timestamp: BigInt(Math.floor(Date.now() / 1000))
        });

        expect(await lazyOracle.getGetTreeRoot()).toBe(123456789n);
    });

    // ────────────────────────────────────
    // Dashboard → StakingVault cross-contract
    // ────────────────────────────────────

    it('Dashboard can fund vault through role-based access', async () => {
        // First create a vault via factory
        await vaultFactory.send(owner.getSender(), { value: toNano('2') }, {
            $$type: 'CreateVault',
            queryId: 500n,
            owner: owner.address,
            nodeOperator: nodeOperator.address,
            depositor: depositor.address,
            shareLimit: toNano('1000'),
            reserveRatioBP: 3000n,
            infraFeeBP: 100n,
            liquidityFeeBP: 50n
        });

        const vaultAddr = await vaultFactory.getGetVaultAddress(owner.address, nodeOperator.address, depositor.address);

        // Deploy Dashboard for this vault
        const dashboard = blockchain.openContract(await Dashboard.fromInit(
            owner.address, vaultAddr, vaultHub.address, nodeOperator.address, 500n
        ));
        await dashboard.send(owner.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 501n });

        // Owner (has FUND_ROLE) funds through dashboard
        const result = await dashboard.send(owner.getSender(), { value: toNano('2') }, {
            $$type: 'DashFund',
            queryId: 502n
        });

        expect(result.transactions).toHaveTransaction({ success: true });
    });

    it('Dashboard role management works', async () => {
        const fakeVault = await blockchain.treasury('dashVault');

        const dashboard = blockchain.openContract(await Dashboard.fromInit(
            admin.address, fakeVault.address, vaultHub.address, nodeOperator.address, 500n
        ));
        await dashboard.send(admin.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 510n });

        // Admin has all roles
        expect(await dashboard.getHasRole(admin.address, 0n)).toBe(true); // ADMIN
        expect(await dashboard.getHasRole(admin.address, 1n)).toBe(true); // FUND

        // Grant FUND role to randomUser
        await dashboard.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'DashGrantRole',
            queryId: 511n,
            account: randomUser.address,
            role: 1n // FUND
        });
        expect(await dashboard.getHasRole(randomUser.address, 1n)).toBe(true);

        // Revoke FUND role
        await dashboard.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'DashRevokeRole',
            queryId: 512n,
            account: randomUser.address,
            role: 1n
        });
        expect(await dashboard.getHasRole(randomUser.address, 1n)).toBe(false);
    });

    it('Dashboard rejects unauthorized fund attempt', async () => {
        const fakeVault = await blockchain.treasury('dashVault2');

        const dashboard = blockchain.openContract(await Dashboard.fromInit(
            admin.address, fakeVault.address, vaultHub.address, nodeOperator.address, 500n
        ));
        await dashboard.send(admin.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 520n });

        // randomUser has no FUND role
        const result = await dashboard.send(randomUser.getSender(), { value: toNano('2') }, {
            $$type: 'DashFund',
            queryId: 521n
        });

        expect(result.transactions).toHaveTransaction({
            from: randomUser.address,
            to: dashboard.address,
            success: false
        });
    });

    it('Dashboard set node operator fee', async () => {
        const fakeVault = await blockchain.treasury('dashVault3');

        const dashboard = blockchain.openContract(await Dashboard.fromInit(
            admin.address, fakeVault.address, vaultHub.address, nodeOperator.address, 500n
        ));
        await dashboard.send(admin.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 530n });

        // nodeOperator has NODE_OPERATOR_MANAGER role
        await dashboard.send(nodeOperator.getSender(), { value: toNano('0.1') }, {
            $$type: 'DashSetFee',
            queryId: 531n,
            nodeOperatorFeeBP: 1000n
        });

        expect(await dashboard.getGetNodeOperatorFeeBp()).toBe(1000n);
    });

    // ────────────────────────────────────
    // Full flow: Factory → Hub → Dashboard
    // ────────────────────────────────────

    it('Full cross-contract flow: create vault, register in hub, manage via dashboard', async () => {
        // Step 1: Create vault via factory (auto-registers with hub)
        const createResult = await vaultFactory.send(owner.getSender(), { value: toNano('2') }, {
            $$type: 'CreateVault',
            queryId: 600n,
            owner: owner.address,
            nodeOperator: nodeOperator.address,
            depositor: depositor.address,
            shareLimit: toNano('1000'),
            reserveRatioBP: 3000n,
            infraFeeBP: 100n,
            liquidityFeeBP: 50n
        });
        expect(createResult.transactions).toHaveTransaction({ success: true });

        const vaultAddr = await vaultFactory.getGetVaultAddress(owner.address, nodeOperator.address, depositor.address);

        // Step 2: Verify vault is registered in hub
        expect(await vaultHub.getIsVaultConnected(vaultAddr)).toBe(true);
        expect(await vaultHub.getGetVaultCount()).toBe(1n);

        // Step 3: Deploy dashboard for the vault
        const dashboard = blockchain.openContract(await Dashboard.fromInit(
            owner.address, vaultAddr, vaultHub.address, nodeOperator.address, 500n
        ));
        await dashboard.send(owner.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 601n });

        // Step 4: Manage vault through dashboard
        await dashboard.send(owner.getSender(), { value: toNano('0.05') }, "connect");
        expect(await dashboard.getGetConnected()).toBe(true);

        // Step 5: Set fee through dashboard
        await dashboard.send(nodeOperator.getSender(), { value: toNano('0.1') }, {
            $$type: 'DashSetFee',
            queryId: 602n,
            nodeOperatorFeeBP: 750n
        });
        expect(await dashboard.getGetNodeOperatorFeeBp()).toBe(750n);

        // Step 6: Register vault in OperatorGrid
        await operatorGrid.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'CreateTier', queryId: 603n, tierId: 1n,
            shareLimit: toNano('10000'), reserveRatioBP: 3000n,
            forcedRebalanceThresholdBP: 7000n, infraFeeBP: 200n,
            liquidityFeeBP: 100n, reservationFeeBP: 50n
        });

        await operatorGrid.send(registry.getSender(), { value: toNano('0.1') }, {
            $$type: 'RegisterVault', queryId: 604n, vault: vaultAddr, tierId: 1n
        });

        const gridReg = await operatorGrid.getGetVaultRegistration(vaultAddr);
        expect(gridReg).not.toBeNull();
        expect(gridReg!.tierId).toBe(1n);

        // Step 7: Oracle reports on vault
        await lazyOracle.send(reporter.getSender(), { value: toNano('0.1') }, {
            $$type: 'SubmitReport',
            queryId: 605n,
            vault: vaultAddr,
            totalValue: toNano('100'),
            inOutDelta: toNano('50'),
            timestamp: BigInt(Math.floor(Date.now() / 1000))
        });

        const oracleReport = await lazyOracle.getGetVaultReport(vaultAddr);
        expect(oracleReport).not.toBeNull();
        expect(oracleReport!.totalValue).toBe(toNano('100'));
    });

    it('UpdateConnection changes vault params in VaultHub', async () => {
        const fakeVault = await blockchain.treasury('updateVault');

        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'ConnectVault',
            queryId: 700n,
            vault: fakeVault.address,
            shareLimit: toNano('500'),
            reserveRatioBP: 5000n,
            infraFeeBP: 100n,
            liquidityFeeBP: 50n
        });

        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'UpdateConnection',
            queryId: 701n,
            vault: fakeVault.address,
            shareLimit: toNano('1000'),
            reserveRatioBP: 4000n,
            infraFeeBP: 200n
        });

        const record = await vaultHub.getGetVaultRecord(fakeVault.address);
        expect(record).not.toBeNull();
        expect(record!.shareLimit).toBe(toNano('1000'));
        expect(record!.reserveRatioBP).toBe(4000n);
    });
});
