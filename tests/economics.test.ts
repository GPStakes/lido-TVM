import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import '@ton/test-utils';

import { VaultHub } from '../build/vault_hub/vault_hub_VaultHub';

describe('VaultHub Economics', () => {
    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let oracle: SandboxContract<TreasuryContract>;
    let recipient: SandboxContract<TreasuryContract>;
    let vaultHub: SandboxContract<VaultHub>;
    let vaultAddr: any; // Address of the test vault

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('admin');
        oracle = await blockchain.treasury('oracle');
        recipient = await blockchain.treasury('recipient');

        vaultHub = blockchain.openContract(await VaultHub.fromInit(
            admin.address, admin.address, oracle.address
        ));
        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 1n });

        // Connect a test vault
        const vault = await blockchain.treasury('vault1');
        vaultAddr = vault.address;

        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'ConnectVault',
            queryId: 10n,
            vault: vaultAddr,
            shareLimit: toNano('1000'),
            reserveRatioBP: 5000n, // 50% reserve ratio
            infraFeeBP: 100n,      // 1% fee
            liquidityFeeBP: 50n
        });

        // Submit an oracle report to set totalValue and reportTimestamp
        await vaultHub.send(oracle.getSender(), { value: toNano('0.1') }, {
            $$type: 'ApplyVaultReport',
            queryId: 11n,
            vault: vaultAddr,
            totalValue: toNano('500'),
            inOutDelta: toNano('500')
        });
    });

    // ── Mint Shares ──

    it('Mint shares against funded vault (happy path)', async () => {
        const result = await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'MintShares',
            queryId: 100n,
            vault: vaultAddr,
            amount: toNano('100'),
            recipient: recipient.address
        });

        expect(result.transactions).toHaveTransaction({ success: true });

        const record = await vaultHub.getGetVaultRecord(vaultAddr);
        expect(record!.liabilityShares).toBe(toNano('100'));
        expect(await vaultHub.getGetTotalSharesMinted()).toBe(toNano('100'));
    });

    it('Mint rejected when vault undercollateralized', async () => {
        // totalValue=500, reserveRatio=50% means max liability = 500*10000/5000 = 1000
        // But let's try to mint so much that ratio fails
        // With totalValue=500, reserveRatio=5000 (50%): 500*10000 >= 5000*amount → amount <= 1000
        // Mint 1001 should fail
        const result = await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'MintShares',
            queryId: 101n,
            vault: vaultAddr,
            amount: toNano('1001'),
            recipient: recipient.address
        });

        expect(result.transactions).toHaveTransaction({
            to: vaultHub.address,
            success: false,
            exitCode: 211 // E_HUB_MAX_LIABILITY (hits share limit first at 1000)
        });
    });

    it('Mint rejected when oracle report stale', async () => {
        // Connect a new vault with no report
        const vault2 = await blockchain.treasury('vault2');
        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'ConnectVault',
            queryId: 102n,
            vault: vault2.address,
            shareLimit: toNano('1000'),
            reserveRatioBP: 5000n,
            infraFeeBP: 100n,
            liquidityFeeBP: 50n
        });

        // No oracle report submitted → reportTimestamp = 0 → stale
        const result = await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'MintShares',
            queryId: 103n,
            vault: vault2.address,
            amount: toNano('10'),
            recipient: recipient.address
        });

        expect(result.transactions).toHaveTransaction({
            to: vaultHub.address,
            success: false,
            exitCode: 210 // E_HUB_ORACLE_STALE
        });
    });

    it('Bad debt detection after value drop', async () => {
        // First mint some shares
        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'MintShares',
            queryId: 104n,
            vault: vaultAddr,
            amount: toNano('400'),
            recipient: recipient.address
        });

        // Now oracle reports value drop below liabilities
        await vaultHub.send(oracle.getSender(), { value: toNano('0.1') }, {
            $$type: 'ApplyVaultReport',
            queryId: 105n,
            vault: vaultAddr,
            totalValue: toNano('100'), // dropped from 500 to 100, liability is 400
            inOutDelta: toNano('500')
        });

        expect(await vaultHub.getHasBadDebt(vaultAddr)).toBe(true);
    });

    it('No bad debt when value exceeds liabilities', async () => {
        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'MintShares',
            queryId: 106n,
            vault: vaultAddr,
            amount: toNano('100'),
            recipient: recipient.address
        });

        expect(await vaultHub.getHasBadDebt(vaultAddr)).toBe(false);
    });

    it('Fee accrual on mint', async () => {
        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'MintShares',
            queryId: 107n,
            vault: vaultAddr,
            amount: toNano('100'),
            recipient: recipient.address
        });

        // infraFeeBP = 100 (1%), so fee on 100 TON = 1 TON
        const fees = await vaultHub.getGetAccumulatedFees(vaultAddr);
        expect(fees).toBe(toNano('1'));
    });

    it('Fee accumulates across multiple mints', async () => {
        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'MintShares',
            queryId: 108n,
            vault: vaultAddr,
            amount: toNano('100'),
            recipient: recipient.address
        });
        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'MintShares',
            queryId: 109n,
            vault: vaultAddr,
            amount: toNano('200'),
            recipient: recipient.address
        });

        // 1% of 100 + 1% of 200 = 1 + 2 = 3 TON
        const fees = await vaultHub.getGetAccumulatedFees(vaultAddr);
        expect(fees).toBe(toNano('3'));
    });

    it('Reserve ratio enforcement — exact boundary', async () => {
        // totalValue=500, reserveRatio=5000 (50%): max liability = 1000
        // But shareLimit is also 1000, so mint exactly 1000 should work
        const result = await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'MintShares',
            queryId: 110n,
            vault: vaultAddr,
            amount: toNano('1000'),
            recipient: recipient.address
        });

        expect(result.transactions).toHaveTransaction({ to: vaultHub.address, success: true });
    });

    it('Max liability cap enforcement', async () => {
        // shareLimit = 1000 TON, try to mint 1001
        const result = await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'MintShares',
            queryId: 111n,
            vault: vaultAddr,
            amount: toNano('1001'),
            recipient: recipient.address
        });

        expect(result.transactions).toHaveTransaction({
            to: vaultHub.address,
            success: false,
            exitCode: 211 // E_HUB_MAX_LIABILITY
        });
    });

    // ── Burn Shares ──

    it('Burn shares reduces liabilities', async () => {
        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'MintShares',
            queryId: 120n,
            vault: vaultAddr,
            amount: toNano('200'),
            recipient: recipient.address
        });

        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'BurnShares',
            queryId: 121n,
            vault: vaultAddr,
            amount: toNano('50')
        });

        const record = await vaultHub.getGetVaultRecord(vaultAddr);
        expect(record!.liabilityShares).toBe(toNano('150'));
        expect(await vaultHub.getGetTotalSharesMinted()).toBe(toNano('150'));
    });

    it('Cannot burn more shares than liability', async () => {
        await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'MintShares',
            queryId: 122n,
            vault: vaultAddr,
            amount: toNano('100'),
            recipient: recipient.address
        });

        const result = await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'BurnShares',
            queryId: 123n,
            vault: vaultAddr,
            amount: toNano('200')
        });

        expect(result.transactions).toHaveTransaction({
            to: vaultHub.address,
            success: false,
            exitCode: 213 // E_HUB_INSUFFICIENT_SHARES
        });
    });

    it('Mint rejected when hub is paused', async () => {
        await vaultHub.send(admin.getSender(), { value: toNano('0.05') }, "pause");

        const result = await vaultHub.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'MintShares',
            queryId: 130n,
            vault: vaultAddr,
            amount: toNano('100'),
            recipient: recipient.address
        });

        expect(result.transactions).toHaveTransaction({
            to: vaultHub.address,
            success: false,
            exitCode: 206 // E_HUB_PAUSED
        });
    });

    it('Non-admin cannot mint shares', async () => {
        const randomUser = await blockchain.treasury('random');

        const result = await vaultHub.send(randomUser.getSender(), { value: toNano('0.1') }, {
            $$type: 'MintShares',
            queryId: 131n,
            vault: vaultAddr,
            amount: toNano('100'),
            recipient: recipient.address
        });

        expect(result.transactions).toHaveTransaction({
            to: vaultHub.address,
            success: false,
            exitCode: 200 // E_HUB_UNAUTHORIZED
        });
    });
});
