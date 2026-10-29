import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../../lib/contract.js";
import { idAddr, idV4, configV4, registerV4 } from "../helpers/ids.js";
import { describeRobinhood } from "../helpers/fork.js";

// PancakeSwap Infinity on Robinhood Chain: the WETH/Index pool its CLPoolManager keeps, a dynamic-fee
// pool behind a hook that sets the fee before each swap and returns no delta, against Uniswap v3's
// 1% WETH/Index pool, the pair's only other pool with liquidity.
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const INDEX = "0x56910d4409f3a0c78c64dd8d0545ff0705389870";
const CL = "0xd01C774d4A66408326Bc65728Ac5Ae5aAf004032";
const HOOK = "0x51854e4BAA4A7c9653B52e42021F1B2B35D31651";
const DYNAMIC = 0x800000;
// meta = [kind, currency0, currency1, fee, tickSpacing, hooks, parameters]: tick spacing 100 and the
// hook's permissions (0x0042) packed into the parameters as Pancake packs them.
const INFI = [6, WETH, INDEX, DYNAMIC, 100, HOOK, "0x0000000000000000000000000000000000000000000000000000000000640042"];
const CFG = configV4(INFI);
const INFI_ID = "0xc57c0ce68d6b3a655bebadead2e98699a161a77428ba3f4f1f4d9c84a65243dd";
const V3_1PCT = "0xD29893fFac8b29eC4Db2cfE0CDB3FE1377c028Ff";

const PAYEE = "0x00000000000000000000000000000000beC0ffEE";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const ONE = 10n ** 18n;

// What a swap on the pool pays, in pips: the protocol fee of its dearer direction, and the LP fee on
// the rest (ProtocolFeeLibrary.calculateSwapFee), as the keeper lists a pool.
const swapFee = (protocol, lp) => {
    const pf = BigInt(Math.max(Number(protocol & 0xfffn), Number((protocol >> 12n) & 0xfffn)));
    return pf + lp - (pf * lp) / 1_000_000n;
};

describeRobinhood("Van Helsing on Robinhood Chain (PancakeSwap Infinity)", function () {
    let conn, ethers, networkHelpers;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ethers = conn.ethers;
        networkHelpers = conn.networkHelpers;
    });

    async function deployFixture() {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), TREASURY], {
            libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null },
            proxy: true,
        });
        const helper = await deploy(conn, "InfinityLibHarness", null, [], { libraries: { InfinityLib: null } });
        return { registry, vh, helper };
    }

    async function fundWeth(to, amount) {
        const weth = await ethers.getContractAt("IWETH", WETH);
        const [whale] = await ethers.getSigners();
        await networkHelpers.setBalance(whale.address, amount + ONE);
        await weth.connect(whale).deposit({ value: amount });
        await weth.connect(whale).transfer(to, amount);
    }

    it("is built with Robinhood Chain's Infinity: its poolId and its live state", async function () {
        const { helper } = await networkHelpers.loadFixture(deployFixture);
        expect(idV4(INFI)).to.equal(INFI_ID);
        expect(await helper.idOf(CFG)).to.equal(INFI_ID);
        const [s, l] = await helper.normalize(CFG);
        expect(s).to.be.gt(0n);
        expect(l).to.be.gt(0n);
    });

    it("swaps through the hooked pool in the Vault's lock", async function () {
        const { helper } = await networkHelpers.loadFixture(deployFixture);
        const index = await ethers.getContractAt("IERC20", INDEX);
        await fundWeth(await helper.getAddress(), ONE / 1000n);
        const out = await helper.swapOnce.staticCall(CFG, true, ONE / 1000n);
        await helper.swapOnce(CFG, true, ONE / 1000n);
        expect(out).to.be.gt(0n);
        expect(await index.balanceOf(await helper.getAddress())).to.equal(out);
    });

    it("wards a dislocated Infinity pool against the v3 pool of its pair", async function () {
        const { registry, vh, helper } = await networkHelpers.loadFixture(deployFixture);
        const cl = new ethers.Contract(CL, ["function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)"], ethers.provider);
        const [, , protocol, lp] = await cl.getSlot0(INFI_ID);
        const id = await registerV4(registry, INFI);
        await registry.setPools(WETH, INDEX, [[idAddr(V3_1PCT), 2, 10_000, 0], [id, 6, swapFee(protocol, lp), 0]]);
        await registry.setToken(WETH, 5n, 0n);

        await fundWeth(await helper.getAddress(), ONE / 50n);
        await helper.swapOnce(CFG, true, ONE / 50n); // a front-run sells WETH into the Infinity pool
        const weth = await ethers.getContractAt("IERC20", WETH);
        const index = await ethers.getContractAt("IERC20", INDEX);
        const before = await weth.balanceOf(PAYEE) + await index.balanceOf(PAYEE);

        const rc = await (await vh["ward(bytes32,address)"](id, PAYEE, { gasLimit: 5_000_000 })).wait();

        const events = rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === "Captured");
        expect(events).to.have.length(1);
        expect(events[0].args.anchor).to.equal(idAddr(V3_1PCT));
        expect(events[0].args.bounty).to.be.gt(0n);
        expect(await weth.balanceOf(PAYEE) + await index.balanceOf(PAYEE)).to.be.gt(before);
        expect(await weth.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await index.balanceOf(await vh.getAddress())).to.equal(0n);
    });
});
