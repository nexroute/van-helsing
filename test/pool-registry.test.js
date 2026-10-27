import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr, idV4, configV4 } from "./helpers/ids.js";

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NATIVE = "0x0000000000000000000000000000000000000000";
const ZH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const V2_PAIR = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE"; // USDT/WBNB Pancake V2
const V3_POOL = "0x172fcd41e0913e95784454622d1c3724f546f849"; // USDT/WBNB V3
const V2_KIND = 0;
const V3_KIND = 2;

// The registry keys pools by a bytes32 id: a pool contract's address zero-padded to 32
// bytes, or a singleton pool's poolId. A singleton pool's config (its PoolKey) is kept packed
// in one word and given back whole (configOf). The list is a quality input, not a safety one
// (fundless). The deployed registry's operator writes its storage directly (write); these
// tests fill PoolRegistryHarness, the same registry with typed writers. No fork needed.
describe("PoolRegistry", function () {
    let conn, ethers, owner, other, registry;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ethers = conn.ethers;
        [owner, other] = await ethers.getSigners();
        registry = await deploy(conn, "PoolRegistryHarness");
    });

    const v2 = (pool, fee) => [idAddr(pool), V2_KIND, fee, 0]; // Pool: (bytes32 id, kind, fee, tax)
    const v3 = (pool, fee) => [idAddr(pool), V3_KIND, fee, 0];

    it("operator-gates setPools and setToken", async function () {
        await expect(registry.connect(other).setPools(USDT, WBNB, [v2(V2_PAIR, 25)])).to.be.revert(ethers);
        await expect(registry.connect(other).setToken(WBNB, 100, 5n)).to.be.revert(ethers);
    });

    it("sets token payout policy (priority + dust floor)", async function () {
        expect((await registry.tokenInfos(WBNB, USDT)).priorityA).to.equal(0n); // default: no preference
        await registry.setToken(WBNB, 100, 5n);
        const info = await registry.tokenInfos(WBNB, USDT);
        expect([info.priorityA, info.minProfitA, info.priorityB, info.minProfitB]).to.deep.equal([100n, 5n, 0n, 0n]);
    });

    it("stores a ranked list in order, kind and fee as stated, and reports each entry", async function () {
        await registry.setPools(USDT, WBNB, [v2(V2_PAIR, 25), v3(V3_POOL, 100)]);

        const pools = await registry.poolsFor(USDT, WBNB);
        expect(pools.length).to.equal(2);
        // the list stores ids only, in the order pushed: V2 first, V3 second
        expect(pools[0]).to.equal(idAddr(V2_PAIR));
        expect(pools[1]).to.equal(idAddr(V3_POOL));
        // pair-order independent
        expect((await registry.poolsFor(WBNB, USDT)).length).to.equal(2);
        // kind + fee live in each pool's entry (the single home VanHelsing reads back);
        // tokens are the pair key
        const [kind, t0, t1, fee, , ok] = await registry.entryOf(idAddr(V2_PAIR));
        expect(ok).to.equal(true);
        expect(kind).to.equal(BigInt(V2_KIND));
        expect(fee).to.equal(25n);
        expect([t0.toLowerCase(), t1.toLowerCase()].sort()).to.deep.equal(
            [USDT.toLowerCase(), WBNB.toLowerCase()].sort(),
        );
        const [, , , v3fee] = await registry.entryOf(idAddr(V3_POOL));
        expect(v3fee).to.equal(100n);
    });

    it("refreshes a pair wholesale, clearing dropped entries", async function () {
        await registry.setPools(USDT, WBNB, [v2(V2_PAIR, 25), v3(V3_POOL, 100)]);
        await registry.setPools(USDT, WBNB, [v3(V3_POOL, 100)]); // oracle refresh: only the V3 pool

        const pools = await registry.poolsFor(USDT, WBNB);
        expect(pools.length).to.equal(1);
        expect(pools[0]).to.equal(idAddr(V3_POOL));
        // the dropped V2 pool's entry was cleared
        const [, , , , , ok] = await registry.entryOf(idAddr(V2_PAIR));
        expect(ok).to.equal(false);
    });

    // A singleton pool: the operator stores its config (its PoolKey) under its poolId.
    const uniMeta = [4, NATIVE, USDT, 500, 10, NATIVE, ZH];
    const infiMeta = [6, NATIVE, USDT, 67, 1, NATIVE, "0x0000000000000000000000000000000000000000000000000000000000010000"];
    const ercMeta = [4, USDT, WBNB, 3000, 60, "0x00000000000000000000000000000000000000aa", ZH];

    // A singleton pool's config is kept packed in one word, its tokens taken from its entry, and
    // given back whole once the pool is listed, whichever is stored first; its shape, the tick
    // spacing and whether currency0 is native, rides on its entry for wardPools. Anything else
    // is kept as written.
    it("stores pool configs, operator-gated, and gives them back whole", async function () {
        const reg = await deploy(conn, "PoolRegistryHarness");
        await expect(reg.connect(other).setConfig(idV4(uniMeta), configV4(uniMeta))).to.be.revert(ethers);
        await reg.setConfig(idV4(uniMeta), configV4(uniMeta));
        await reg.setPools(USDT, WBNB, [[idV4(uniMeta), 4, 500, 0], [idV4(infiMeta), 6, 67, 0], [idV4(ercMeta), 4, 3000, 0]]);
        await reg.setConfig(idV4(infiMeta), configV4(infiMeta));
        await reg.setConfig(idV4(ercMeta), configV4(ercMeta));
        for (const [meta, shape] of [[uniMeta, 10 | 1 << 24], [infiMeta, 1 | 1 << 24], [ercMeta, 60]]) {
            expect(await reg.configOf(idV4(meta))).to.equal(configV4(meta));
            expect(Number((await reg.wardPools(idV4(meta)))[0][4])).to.equal(shape);
        }
        const route = ethers.hexlify(ethers.randomBytes(85));
        await reg.setConfig(ethers.id("a route"), route);
        expect(await reg.configOf(ethers.id("a route"))).to.equal(route);
    });

    // VanHelsing reads a singleton pool's key word itself, from poolKeys at slot 6 (its
    // REG_POOL_KEYS) through read, and unpacks it as configOf does.
    it("keeps each singleton's key word in poolKeys, slot 6, where VanHelsing reads it", async function () {
        const reg = await deploy(conn, "PoolRegistryHarness");
        const keySlot = (id) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [id, 6]));
        for (const meta of [uniMeta, infiMeta, ercMeta]) {
            const [, c0, , fee, spacing, hooks, params] = meta;
            await reg.setConfig(idV4(meta), configV4(meta));
            const word = BigInt(hooks) | BigInt(fee) << 160n | BigInt(spacing) << 184n
                | (c0 === NATIVE ? 1n << 208n : 0n) | BigInt(params) << 216n;
            expect(await reg.read(keySlot(idV4(meta)))).to.equal(word);
        }
        await reg.setConfig(ethers.id("a route"), ethers.hexlify(ethers.randomBytes(85)));
        expect(await reg.read(keySlot(ethers.id("a route")))).to.equal(0n, "a config that does not pack has no key word");
    });

    it("returns empty config for an unset id", async function () {
        expect(await registry.configOf(idAddr(V3_POOL))).to.equal("0x");
    });

    // wardPools: what a ward needs from the registry in one call, its pool's entry and its
    // anchor, the first pool listed for the pair other than itself.
    it("gives a ward its pool's entry and its anchor in one call", async function () {
        const reg = await deploy(conn, "PoolRegistryHarness");
        const a = v2(V2_PAIR, 25);
        const b = v3(V3_POOL, 100);
        const c = [idAddr("0x0000000000000000000000000000000000000c0c"), V2_KIND, 30, 7];
        await reg.setPools(USDT, WBNB, [a, b, c]);
        const pool = (r) => [r[0], Number(r[1]), Number(r[2]), Number(r[3])];
        // wardPools returns (pool, token0, token1, ok, anchor), unnamed: it is written in assembly
        const ward = async (id) => {
            const [p, token0, token1, ok, anchor] = await reg.wardPools(id);
            return { pool: p, token0, token1, ok, anchor };
        };

        let r = await ward(a[0]);
        expect(r.ok).to.equal(true);
        expect(pool(r.pool)).to.deep.equal(a);
        expect(pool(r.anchor)).to.deep.equal(b, "the first pool's anchor is the second");
        expect([r.token0, r.token1]).to.deep.equal(BigInt(USDT) < BigInt(WBNB) ? [USDT, WBNB] : [WBNB, USDT]);
        r = await ward(c[0]);
        expect(pool(r.pool)).to.deep.equal(c);
        expect(pool(r.anchor)).to.deep.equal(a, "any other pool's anchor is the first");

        // An untaxed anchor is read from its entry's second slot alone, a taxed one's tax from its first.
        await reg.setPools(USDT, WBNB, [c, a]);
        r = await ward(a[0]);
        expect(pool(r.anchor)).to.deep.equal(c, "a taxed anchor comes with its tax");
        r = await ward(c[0]);
        expect(pool(r.pool)).to.deep.equal(c);
        expect(pool(r.anchor)).to.deep.equal(a);

        await reg.setPools(USDT, WBNB, [a]);
        r = await ward(a[0]);
        expect(r.ok).to.equal(true);
        expect(r.anchor[0]).to.equal(ZH, "a pool alone has no anchor");
        r = await ward(b[0]);
        expect(r.ok).to.equal(false, "a pool no list holds");
        expect(r.anchor[0]).to.equal(ZH);
    });

    // The deployed registry has no typed writers: its operator writes the storage straight,
    // (slot, value) pairs of 64 bytes computed off-chain.
    describe("write", function () {
        const pair = (slot, value) => ethers.concat([ethers.zeroPadValue(slot, 32), ethers.zeroPadValue(value, 32)]);
        let A, B;
        before(function () {
            [A, B] = [ethers.id("a slot"), ethers.id("another slot")];
        });

        it("stores the slots it is given, for the operator alone", async function () {
            const reg = await deploy(conn, "PoolRegistry");
            const at = await reg.getAddress();
            expect(await reg.operator()).to.equal(owner.address, "the deployer writes until it appoints another");
            await expect(reg.connect(other).write(pair(A, "0x01"))).to.be.revert(ethers);
            await reg.write(ethers.concat([pair(A, "0x01"), pair(B, ethers.id("value"))]));
            expect(await ethers.provider.getStorage(at, A)).to.equal(ethers.zeroPadValue("0x01", 32));
            expect(await ethers.provider.getStorage(at, B)).to.equal(ethers.id("value"));
        });

        it("refuses the roles' slots and a partial pair", async function () {
            const reg = await deploy(conn, "PoolRegistry");
            await expect(reg.write(pair(ZH, other.address))).to.be.revert(ethers);
            await expect(reg.write(pair("0x01", other.address))).to.be.revert(ethers);
            expect(await reg.owner()).to.equal(owner.address);
            expect(await reg.operator()).to.equal(owner.address);
            await expect(reg.write(ethers.concat([pair(A, "0x01"), "0x01"]))).to.be.revert(ethers);
            expect(await ethers.provider.getStorage(await reg.getAddress(), A)).to.equal(ZH);
        });

        // An anchor swap changes two slots: the two ids that trade places.
        it("costs one slot's write for each slot that changes", async function () {
            const reg = await deploy(conn, "PoolRegistry");
            await reg.write(ethers.concat([pair(A, ethers.id("first")), pair(B, ethers.id("second"))]));
            const tx = await reg.write(ethers.concat([pair(A, ethers.id("second")), pair(B, ethers.id("first"))]));
            const gas = (await tx.wait()).gasUsed;
            console.log(`      two slots changed: ${gas} gas`);
            expect(gas).to.be.lt(40_000n);
        });
    });

    // The owner only appoints the operator, the key that writes, and hands ownership on: a
    // lost or leaked operator key is replaced in one call.
    describe("roles", function () {
        const pair = (slot, value) => ethers.concat([ethers.zeroPadValue(slot, 32), ethers.zeroPadValue(value, 32)]);

        it("lets the owner alone appoint the operator, who alone writes", async function () {
            const reg = await deploy(conn, "PoolRegistry");
            const slot = ethers.id("a slot");
            await expect(reg.connect(other).setOperator(other.address)).to.be.revert(ethers);
            await expect(reg.setOperator(other.address)).to.emit(reg, "OperatorChanged").withArgs(other.address);
            await expect(reg.write(pair(slot, "0x01"))).to.be.revert(ethers, "the owner does not write");
            await reg.connect(other).write(pair(slot, "0x01"));
            await reg.setOperator(ethers.ZeroAddress);
            await expect(reg.connect(other).write(pair(slot, "0x02"))).to.be.revert(ethers, "no operator, no writes");
        });

        it("hands ownership on, never to no one", async function () {
            const reg = await deploy(conn, "PoolRegistry");
            await expect(reg.transferOwnership(ethers.ZeroAddress)).to.be.revert(ethers);
            await reg.transferOwnership(other.address);
            await expect(reg.setOperator(owner.address)).to.be.revert(ethers, "the old owner");
            await reg.connect(other).setOperator(other.address);
            expect(await reg.operator()).to.equal(other.address);
        });

        it("gates the harness's typed writers on the operator", async function () {
            const reg = await deploy(conn, "PoolRegistryHarness");
            await reg.setOperator(other.address);
            await expect(reg.setPools(USDT, WBNB, [v2(V2_PAIR, 25)])).to.be.revert(ethers);
            await reg.connect(other).setPools(USDT, WBNB, [v2(V2_PAIR, 25)]);
            expect((await reg.poolsFor(USDT, WBNB)).length).to.equal(1);
        });
    });
});
