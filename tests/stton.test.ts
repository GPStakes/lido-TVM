import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import '@ton/test-utils';

import { StTON } from '../build/st_ton/st_ton_StTON';

describe('StTON — Rebasable Share Token (stETH equivalent)', () => {
    let blockchain: Blockchain;
    let vaultHub: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let charlie: SandboxContract<TreasuryContract>;
    let randomUser: SandboxContract<TreasuryContract>;
    let stTON: SandboxContract<StTON>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        vaultHub = await blockchain.treasury('vaultHub');
        alice = await blockchain.treasury('alice');
        bob = await blockchain.treasury('bob');
        charlie = await blockchain.treasury('charlie');
        randomUser = await blockchain.treasury('random');

        stTON = blockchain.openContract(await StTON.fromInit(vaultHub.address));
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 1n });
    });

    // ── Minting ──

    it('VaultHub can mint shares to recipient', async () => {
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONMint', queryId: 10n, recipient: alice.address, shareAmount: toNano('100')
        });

        expect(await stTON.getGetSharesOf(alice.address)).toBe(toNano('100'));
        expect(await stTON.getGetTotalShares()).toBe(toNano('100'));
    });

    it('Non-VaultHub cannot mint', async () => {
        const result = await stTON.send(randomUser.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONMint', queryId: 11n, recipient: alice.address, shareAmount: toNano('100')
        });
        expect(result.transactions).toHaveTransaction({
            to: stTON.address, success: false, exitCode: 700
        });
    });

    // ── Burning ──

    it('VaultHub can burn shares', async () => {
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONMint', queryId: 20n, recipient: alice.address, shareAmount: toNano('100')
        });
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONBurn', queryId: 21n, account: alice.address, shareAmount: toNano('40')
        });

        expect(await stTON.getGetSharesOf(alice.address)).toBe(toNano('60'));
        expect(await stTON.getGetTotalShares()).toBe(toNano('60'));
    });

    it('Cannot burn more than balance', async () => {
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONMint', queryId: 22n, recipient: alice.address, shareAmount: toNano('50')
        });
        const result = await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONBurn', queryId: 23n, account: alice.address, shareAmount: toNano('51')
        });
        expect(result.transactions).toHaveTransaction({
            to: stTON.address, success: false, exitCode: 702
        });
    });

    // ── Rebase mechanics (the core stETH equivalency) ──

    it('Balance rebases upward after oracle report (staking rewards)', async () => {
        // Mint 100 shares to alice, 100 to bob
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONMint', queryId: 30n, recipient: alice.address, shareAmount: toNano('100')
        });
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONMint', queryId: 31n, recipient: bob.address, shareAmount: toNano('100')
        });

        // Set totalPooledTON = 200 (1:1 initially)
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONRebase', queryId: 32n, newTotalPooledTON: toNano('200')
        });

        expect(await stTON.getGetBalanceOf(alice.address)).toBe(toNano('100'));
        expect(await stTON.getGetBalanceOf(bob.address)).toBe(toNano('100'));

        // Oracle reports staking rewards: totalPooledTON increases to 220 (+10%)
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONRebase', queryId: 33n, newTotalPooledTON: toNano('220')
        });

        // Both balances should increase by 10%
        expect(await stTON.getGetBalanceOf(alice.address)).toBe(toNano('110'));
        expect(await stTON.getGetBalanceOf(bob.address)).toBe(toNano('110'));

        // But shares remain unchanged
        expect(await stTON.getGetSharesOf(alice.address)).toBe(toNano('100'));
        expect(await stTON.getGetSharesOf(bob.address)).toBe(toNano('100'));
    });

    it('Balance rebases downward after slashing event', async () => {
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONMint', queryId: 40n, recipient: alice.address, shareAmount: toNano('100')
        });
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONRebase', queryId: 41n, newTotalPooledTON: toNano('100')
        });
        expect(await stTON.getGetBalanceOf(alice.address)).toBe(toNano('100'));

        // Slashing: pool drops by 20%
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONRebase', queryId: 42n, newTotalPooledTON: toNano('80')
        });

        expect(await stTON.getGetBalanceOf(alice.address)).toBe(toNano('80'));
        // Shares unchanged
        expect(await stTON.getGetSharesOf(alice.address)).toBe(toNano('100'));
    });

    // ── Share/TON conversion (mirrors stETH getSharesByPooledEth) ──

    it('Shares-to-TON and TON-to-shares conversion is consistent', async () => {
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONMint', queryId: 50n, recipient: alice.address, shareAmount: toNano('200')
        });
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONRebase', queryId: 51n, newTotalPooledTON: toNano('300')
        });

        // 200 shares at 300/200 ratio = 1.5 TON per share
        // 100 TON = 100 * 200 / 300 = 66.666... shares (truncated to 66)
        const sharesFor100 = await stTON.getGetSharesByPooledTon(toNano('100'));
        expect(sharesFor100).toBe(toNano('100') * toNano('200') / toNano('300'));

        // Round-trip: shares → TON → shares should be consistent
        const tonForShares = await stTON.getGetPooledTonByShares(toNano('50'));
        expect(tonForShares).toBe(toNano('50') * toNano('300') / toNano('200'));
    });

    // ── Transfers ──

    it('User can transfer shares', async () => {
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONMint', queryId: 60n, recipient: alice.address, shareAmount: toNano('100')
        });

        await stTON.send(alice.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONTransferShares', queryId: 61n, to: bob.address, shareAmount: toNano('30')
        });

        expect(await stTON.getGetSharesOf(alice.address)).toBe(toNano('70'));
        expect(await stTON.getGetSharesOf(bob.address)).toBe(toNano('30'));
    });

    it('Cannot transfer more than balance', async () => {
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONMint', queryId: 62n, recipient: alice.address, shareAmount: toNano('50')
        });
        const result = await stTON.send(alice.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONTransferShares', queryId: 63n, to: bob.address, shareAmount: toNano('51')
        });
        expect(result.transactions).toHaveTransaction({
            to: stTON.address, success: false, exitCode: 702
        });
    });

    // ── Allowance / TransferFrom (ERC-20 equivalent) ──

    it('Approve and transferFrom works', async () => {
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONMint', queryId: 70n, recipient: alice.address, shareAmount: toNano('100')
        });

        // Alice approves bob to spend 50 shares
        await stTON.send(alice.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONApprove', queryId: 71n, spender: bob.address, shareAmount: toNano('50')
        });
        expect(await stTON.getGetAllowance(alice.address, bob.address)).toBe(toNano('50'));

        // Bob transfers 30 from alice to charlie
        await stTON.send(bob.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONTransferFrom', queryId: 72n, from: alice.address, to: charlie.address, shareAmount: toNano('30')
        });

        expect(await stTON.getGetSharesOf(alice.address)).toBe(toNano('70'));
        expect(await stTON.getGetSharesOf(charlie.address)).toBe(toNano('30'));
        expect(await stTON.getGetAllowance(alice.address, bob.address)).toBe(toNano('20'));
    });

    it('TransferFrom fails without sufficient allowance', async () => {
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONMint', queryId: 73n, recipient: alice.address, shareAmount: toNano('100')
        });

        const result = await stTON.send(bob.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONTransferFrom', queryId: 74n, from: alice.address, to: charlie.address, shareAmount: toNano('10')
        });
        expect(result.transactions).toHaveTransaction({
            to: stTON.address, success: false, exitCode: 700
        });
    });

    // ── Multi-holder rebase scenario ──

    it('Multiple holders rebase proportionally (stETH core invariant)', async () => {
        // Alice: 300 shares, Bob: 100 shares, Charlie: 600 shares
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONMint', queryId: 80n, recipient: alice.address, shareAmount: toNano('300')
        });
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONMint', queryId: 81n, recipient: bob.address, shareAmount: toNano('100')
        });
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONMint', queryId: 82n, recipient: charlie.address, shareAmount: toNano('600')
        });

        // Total shares: 1000. Set pool to 1000 (1:1)
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONRebase', queryId: 83n, newTotalPooledTON: toNano('1000')
        });

        // Rebase to 1500 (+50% rewards)
        await stTON.send(vaultHub.getSender(), { value: toNano('0.1') }, {
            $$type: 'StTONRebase', queryId: 84n, newTotalPooledTON: toNano('1500')
        });

        // Alice: 300/1000 * 1500 = 450
        // Bob:   100/1000 * 1500 = 150
        // Charlie: 600/1000 * 1500 = 900
        expect(await stTON.getGetBalanceOf(alice.address)).toBe(toNano('450'));
        expect(await stTON.getGetBalanceOf(bob.address)).toBe(toNano('150'));
        expect(await stTON.getGetBalanceOf(charlie.address)).toBe(toNano('900'));
    });
});
