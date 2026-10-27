import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr, idV4, configV4, registerV4 } from "./helpers/ids.js";
import { describeFork } from "./helpers/fork.js";

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NATIVE = "0x0000000000000000000000000000000000000000";
const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const CL = "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b"; // CLPoolManager (part of the poolId hash)
const V3_DEEP = "0x172fcd41e0913e95784454622d1c3724f546f849"; // Pancake V3 USDT/WBNB 0.01%
const V2_PANCAKE = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE"; // Pancake V2 USDT/WBNB
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";

// Pancake Infinity CL native-BNB/USDT pool: no hooks, fee 67, tickSpacing 1 (parameters
// = tickSpacing << 16 = 0x010000). currency0 = native address(0), currency1 = USDT, so it
// maps to the USDT/WBNB ERC20 pair and is FLIPPED (inverted price, reversed directions).
// Deep enough (~2e22) that a small swap barely moves it: few ticks, fast. Kind 6.
const PARAMS_TS1 = "0x0000000000000000000000000000000000000000000000000000000000010000";
const INFI_NATIVE = [6, NATIVE, USDT, 67, 1, NO_HOOKS, PARAMS_TS1];
// Packed config bytes for the harness/registry; INFI_NATIVE still feeds idV4/registerV4.
const CFG_INFI = configV4(INFI_NATIVE);
const BLOCK = 103808000;
const ONE = 10n ** 18n;

const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;

describeFork("VanHelsing + Pancake Infinity CL", function () {
    let conn, ethers, networkHelpers, loadFixture;

    before(async function () {
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
        ethers = conn.ethers;
        networkHelpers = conn.networkHelpers;
        loadFixture = (fn) => networkHelpers.loadFixture(fn);
    });

    async function deployFixture() {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY], { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } });
        const helper = await deploy(conn, "InfinityLibHarness", null, [], { libraries: { InfinityLib: null } });
        const holder = await deploy(conn, "LockHolder", null, [], { libraries: { UniV4Lib: null, InfinityLib: null } }); // calls ward inside its own lock
        return { registry, vh, helper, holder };
    }

    // Front-run a V2 pool: dump WBNB straight into it and sync.
    async function skewV2Wbnb(pair, amount) {
        const p = new ethers.Contract(pair, ["function sync() external"], ethers.provider);
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        const [whale] = await ethers.getSigners();
        await networkHelpers.setBalance(whale.address, amount + ONE);
        await wbnb.connect(whale).deposit({ value: amount });
        await wbnb.connect(whale).transfer(pair, amount);
        await p.connect(whale).sync();
    }

    // Fund `helper` with WBNB and swap it for USDT (the flipped pool takes native, so the
    // WBNB is unwrapped at settle), dislocating the pool upward.
    async function skewWithWbnb(helper, amount) {
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        const [whale] = await ethers.getSigners();
        await networkHelpers.setBalance(whale.address, amount + ONE);
        await wbnb.connect(whale).deposit({ value: amount });
        await wbnb.connect(whale).transfer(await helper.getAddress(), amount);
        await helper.swapOnce(CFG_INFI, false, amount);
    }

    it("normalizes a real Pancake CL pool (flipped) and derives a consistent id", async function () {
        const { registry, helper } = await loadFixture(deployFixture);
        const [s, l] = await helper.normalize(CFG_INFI);
        expect(l).to.be.gt(0n);
        expect(s).to.be.gt(MIN_SQRT);
        expect(s).to.be.lt(MAX_SQRT);

        // the poolId InfinityLib derives (6-field Pancake key) equals the JS-computed one
        expect(await helper.idOf(CFG_INFI)).to.equal(idV4(INFI_NATIVE));
    });

    // V4Depth reads a pool straight from the CLPoolManager's storage: the pools mapping at slot
    // 4, each pool's state laid out as Uniswap's StateLibrary has it. What those slots hold is
    // what the manager's own getters return.
    it("keeps a pool's state where V4Depth reads it", async function () {
        const id = idV4(INFI_NATIVE);
        const cl = new ethers.Contract(CL, [
            "function extsload(bytes32) view returns (bytes32)",
            "function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)",
            "function getLiquidity(bytes32) view returns (uint128)",
            "function getPoolBitmapInfo(bytes32, int16) view returns (uint256)",
            "function getPoolTickInfo(bytes32, int24) view returns ((uint128, int128, uint256, uint256))",
        ], ethers.provider);
        const coder = ethers.AbiCoder.defaultAbiCoder();
        const slotOf = (key, type, mapSlot) => BigInt(ethers.keccak256(coder.encode([type, "uint256"], [key, mapSlot])));
        const at = async (slot) => BigInt(await cl.extsload(ethers.toBeHex(slot, 32)));
        const state = slotOf(id, "bytes32", 4n);

        const [sqrt, tick] = await cl.getSlot0(id);
        const w = await at(state);
        expect(w & ((1n << 160n) - 1n)).to.equal(sqrt);
        expect(BigInt.asIntN(24, w >> 160n)).to.equal(tick);
        expect(await at(state + 3n)).to.equal(await cl.getLiquidity(id));

        // tick spacing 1: a bitmap bit is a tick. The current tick's word, and a tick it marks.
        const word = Number(tick) >> 8;
        const bitmap = await cl.getPoolBitmapInfo(id, word);
        expect(await at(slotOf(word, "int256", state + 5n))).to.equal(bitmap);
        expect(bitmap).to.not.equal(0n);
        let bit = 0;
        while (((bitmap >> BigInt(bit)) & 1n) === 0n) bit++;
        const marked = word * 256 + bit;
        const [, net] = await cl.getPoolTickInfo(id, marked);
        expect(net).to.not.equal(0n);
        expect(BigInt.asIntN(128, (await at(slotOf(marked, "int256", state + 4n))) >> 128n)).to.equal(net);
    });

    it("locks the Vault, swaps on the CLPoolManager, takes and settles (flip + native)", async function () {
        const { helper } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const [sBefore] = await helper.normalize(CFG_INFI);

        await skewWithWbnb(helper, ONE / 10n); // 0.1 WBNB: deep pool, few ticks
        expect(await usdt.balanceOf(await helper.getAddress())).to.be.gt(0n); // received USDT
        const [sAfter] = await helper.normalize(CFG_INFI);
        expect(sAfter).to.be.gt(sBefore); // WBNB in (token space) raises the price
    });

    it("drives a dislocated Pancake CL pool (flipped driver) and sinks into the V3 alt", async function () {
        const { registry, vh, helper } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        const id = await registerV4(registry, INFI_NATIVE);
        await registry.setPools(USDT, WBNB, [[id, 6, 67, 0], [idAddr(V3_DEEP), 2, 100, 0]]);

        await skewWithWbnb(helper, 10n * ONE); // dislocate the Pancake pool
        const [sSkewed] = await helper.normalize(CFG_INFI);
        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);

        await vh["ward(bytes32,address)"](id, BENEFICIARY, { gasLimit: 8_000_000 });

        const gain = (await usdt.balanceOf(BENEFICIARY)) - usdtBefore + (await wbnb.balanceOf(BENEFICIARY)) - wbnbBefore;
        expect(gain).to.be.gt(0n);
        const [sAfter] = await helper.normalize(CFG_INFI);
        expect(sAfter).to.be.lt(sSkewed); // the skew raised the price; restored down
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await ethers.provider.getBalance(await vh.getAddress())).to.equal(0n);
    });

    // A Pancake hook, or a router's lock callback, calls ward while the Vault's lock is
    // already held: the ward trades inside that lock instead of taking its own.
    it("wards a dislocated Pancake CL pool from inside a Vault lock someone else holds", async function () {
        const { registry, vh, helper, holder } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        const id = await registerV4(registry, INFI_NATIVE);
        await registry.setPools(USDT, WBNB, [[id, 6, 67, 0], [idAddr(V3_DEEP), 2, 100, 0]]);

        await skewWithWbnb(helper, 10n * ONE);
        const [sSkewed] = await helper.normalize(CFG_INFI);
        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);

        await holder.wardInInfinityLock(await vh.getAddress(), id, BENEFICIARY, CFG_INFI, false, 0n, { gasLimit: 8_000_000 });

        const gain = (await usdt.balanceOf(BENEFICIARY)) - usdtBefore + (await wbnb.balanceOf(BENEFICIARY)) - wbnbBefore;
        expect(gain).to.be.gt(0n);
        const [sAfter] = await helper.normalize(CFG_INFI);
        expect(sAfter).to.be.lt(sSkewed);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await ethers.provider.getBalance(await vh.getAddress())).to.equal(0n);
    });

    it("drives a dislocated V2 pool and sinks into the Pancake CL alt (nested lock)", async function () {
        const { registry, vh } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        const id = await registerV4(registry, INFI_NATIVE);
        await registry.setPools(USDT, WBNB, [[idAddr(V2_PANCAKE), 0, 25, 0], [id, 6, 67, 0]]);

        await skewV2Wbnb(V2_PANCAKE, 300n * ONE);
        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);

        await vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), BENEFICIARY, { gasLimit: 8_000_000 });

        const gain = (await usdt.balanceOf(BENEFICIARY)) - usdtBefore + (await wbnb.balanceOf(BENEFICIARY)) - wbnbBefore;
        expect(gain).to.be.gt(0n);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await ethers.provider.getBalance(await vh.getAddress())).to.equal(0n);
    });

    it("sinks into the Pancake CL alt from inside an open Vault lock (V2 driver)", async function () {
        const { registry, vh, holder } = await loadFixture(deployFixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);

        const id = await registerV4(registry, INFI_NATIVE);
        await registry.setPools(USDT, WBNB, [[idAddr(V2_PANCAKE), 0, 25, 0], [id, 6, 67, 0]]);

        await skewV2Wbnb(V2_PANCAKE, 300n * ONE);
        const usdtBefore = await usdt.balanceOf(BENEFICIARY);
        const wbnbBefore = await wbnb.balanceOf(BENEFICIARY);

        await holder.wardInInfinityLock(await vh.getAddress(), idAddr(V2_PANCAKE), BENEFICIARY, CFG_INFI, false, 0n, { gasLimit: 8_000_000 });

        const gain = (await usdt.balanceOf(BENEFICIARY)) - usdtBefore + (await wbnb.balanceOf(BENEFICIARY)) - wbnbBefore;
        expect(gain).to.be.gt(0n);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await ethers.provider.getBalance(await vh.getAddress())).to.equal(0n);
    });
});
