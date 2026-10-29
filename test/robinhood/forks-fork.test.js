import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../../lib/contract.js";
import { idAddr, idRoute, configRoute, ROUTE } from "../helpers/ids.js";
import { describeRobinhood } from "../helpers/fork.js";

// The v2 and v3 forks Robinhood Chain's arbitrage runs through, which the contract trades as V2 and
// V3 pools: it reads a V3 pool's slot0, ticks and bitmap by their leading words and pays any V3-style
// callback through its fallback, so a fork that keeps Uniswap's ABI needs nothing of its own. Each is
// dislocated and warded against a pool of its pair, or, where its pair has no other pool, a route.

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const MICRODUCK = "0xD5f1afEA47b1A9eab414D2ee740cF1d6d039E725";
const UNI_V3_WETH_USDG = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca"; // Uniswap v3, 0.01%: the anchor
const FORK_V3_WETH_USDG = "0x9b050cb1f265094b0977160a2bd7da8c9e529c3c"; // factory 0xE51960f1, Uniswap v3's code, 0.05%
const FORK_V3_WETH_MICRODUCK = "0xe08ea48adcc183e954ce8d2f13e59b5fbe45a0e3"; // factory 0x9a8442cb, 1%
const FORK_V2_WETH_MICRODUCK = "0x197c901a45da38715848c3c166e0d5b85ee13a51"; // factory 0xc802A440
const GIGA_WETH_USDG = "0xb2a6ad51b3ea3cdc8d3508cca147a43471382e53"; // Giga (0xEce6eCd6), Pancake V3's code, 0.01%
const SWAPHOOD_WETH_USDG = "0x6356d82a3d7b9223764339b5f50e7ed01641fb30"; // SwapHood (0x0Ec554F0), Pancake V3's code, 0.05%
const RAMSES_USDG_MICRODUCK = "0xa7b68ce0cf9eb5a3d3880d3a4853aa4c77db2567"; // Ramses V3 (0xE0C4CEb9), tick spacing 300
const UNI_V3_USDG_MICRODUCK = "0x2731574c9df59f287b89b7fb1382749c80d0a1ca"; // Uniswap v3, 1%, nearly empty
const GOO = "0x6572eade9fb17f4027baf92feac222b9aa746bd0";
const LAUNCHPAD_USDG_GOO = "0x3639c005e0171bd09d079b28734c76aa9fefc087"; // factory 0x221A6239, 1%
const LAUNCHPAD_WETH_GOO = "0x841f00216a273641ed583916e668e24b4a89d1e7"; // factory 0x221A6239, 1%
const ABYSS = "0x15f3385625d7e364c5a6216fbbceadf10fa90e7d", SEA = "0x813d909bec3d16c10a6e1e5e0a6725c332f735ba";
const ABYSS_WETH_ABYSS = "0xdec74a2afabd34aa6f268c5161d2e9e210ca7185"; // Abyss (0xe7feF2BC), Pancake V3's code, 1%
const ABYSS_WETH_SEA = "0xdab5deed00cd98f597f16215932224a83e7d62f3"; // Abyss, 0.3%
const ABYSS_ABYSS_SEA = "0x6ca02248dbaca0649f2279947639043f7eee10c5"; // Abyss, 0.3%

const PAYEE = "0x00000000000000000000000000000000beC0ffEE";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const ONE = 10n ** 18n;

describeRobinhood("Van Helsing on Robinhood Chain's v2 and v3 forks", function () {
    let conn, ethers, networkHelpers;

    // Each case forks the chain's head afresh: the public RPC keeps only the last ~4,000 blocks'
    // state (about seven minutes), which one fork shared by every case outlives.
    async function fresh() {
        conn = await network.create({ network: "hardhat" });
        ({ ethers, networkHelpers } = conn);
        return deployFixture();
    }

    async function deployFixture() {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), TREASURY], {
            libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null },
            proxy: true,
        });
        const poker = await deploy(conn, "PoolPoker");
        await registry.setToken(WETH, 5n, 0n);
        return { registry, vh, poker };
    }

    async function fundWeth(to, amount) {
        const weth = await ethers.getContractAt("IWETH", WETH);
        const [whale] = await ethers.getSigners();
        await networkHelpers.setBalance(whale.address, amount + ONE);
        await weth.connect(whale).deposit({ value: amount });
        await weth.connect(whale).transfer(to, amount);
    }

    async function v3Fee(pool) {
        return Number(await new ethers.Contract(pool, ["function fee() view returns (uint24)"], ethers.provider).fee());
    }

    // The ward's one Captured event, against the anchor `anchorId`, with nothing left behind.
    async function expectCapture(vh, rc, anchorId, tokens) {
        const events = rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === "Captured");
        expect(events, "one capture").to.have.length(1);
        expect(events[0].args.anchor).to.equal(anchorId);
        expect(events[0].args.bounty).to.be.gt(0n);
        for (const t of tokens) expect(await (await ethers.getContractAt("IERC20", t)).balanceOf(await vh.getAddress())).to.equal(0n);
    }

    // The Slipstream-style pools (factory 0xc63d7338's, and Slipstream "up"'s, a six-word slot0) are
    // warded the same way in measurement/robinhood/slipstream-live.mjs, on the chain's own state:
    // their swap stops here on an opcode EDR lacks.
    // Each skew is a front-run selling WETH into the pool: well past both fees for the pool's depth,
    // and few enough ticks crossed that the fork, which fetches every slot it touches, stays quick.
    for (const [name, pool, skew] of [
        ["a fork with Uniswap v3's code", FORK_V3_WETH_USDG, 20n * ONE],
        ["Giga, Pancake V3's code", GIGA_WETH_USDG, 2n * ONE],
        ["SwapHood, Pancake V3's code", SWAPHOOD_WETH_USDG, 2n * ONE],
    ]) {
        it(`wards ${name} (WETH/USDG) against Uniswap v3's 0.01% pool`, async function () {
            const { registry, vh, poker } = await fresh();
            await registry.setPools(WETH, USDG, [[idAddr(UNI_V3_WETH_USDG), 2, 100, 0], [idAddr(pool), 2, await v3Fee(pool), 0]]);
            await fundWeth(await poker.getAddress(), skew);
            await poker.poke(pool, true, skew);

            const rc = await (await vh["ward(bytes32,address)"](idAddr(pool), PAYEE, { gasLimit: 6_000_000 })).wait();
            await expectCapture(vh, rc, idAddr(UNI_V3_WETH_USDG), [WETH, USDG]);
        });
    }

    it("wards a v3 fork's WETH/microduck pool against a v2 fork's pair, and the pair against the pool", async function () {
        for (const [warded, anchor] of [[FORK_V3_WETH_MICRODUCK, FORK_V2_WETH_MICRODUCK], [FORK_V2_WETH_MICRODUCK, FORK_V3_WETH_MICRODUCK]]) {
            const { registry, vh, poker } = await fresh();
            const v3 = [idAddr(FORK_V3_WETH_MICRODUCK), 2, await v3Fee(FORK_V3_WETH_MICRODUCK), 0];
            const v2 = [idAddr(FORK_V2_WETH_MICRODUCK), 0, 30, 0];
            await registry.setPools(WETH, MICRODUCK, warded === FORK_V3_WETH_MICRODUCK ? [v2, v3] : [v3, v2]);
            await fundWeth(await poker.getAddress(), ONE / 10n);
            if (warded === FORK_V3_WETH_MICRODUCK) await poker.poke(warded, true, ONE / 10n);
            else await poker.pokeV2(warded, true, ONE / 10n, 9970n);

            const rc = await (await vh["ward(bytes32,address)"](idAddr(warded), PAYEE, { gasLimit: 6_000_000 })).wait();
            await expectCapture(vh, rc, idAddr(anchor), [WETH, MICRODUCK]);
        }
    });

    it("wards Ramses V3's USDG/microduck pool against Uniswap v3's, and Uniswap v3's against it", async function () {
        for (const [warded, anchor] of [[RAMSES_USDG_MICRODUCK, UNI_V3_USDG_MICRODUCK], [UNI_V3_USDG_MICRODUCK, RAMSES_USDG_MICRODUCK]]) {
            const { registry, vh, poker } = await fresh();
            const entry = async (pool) => [idAddr(pool), 2, await v3Fee(pool), 0];
            await registry.setPools(USDG, MICRODUCK, [await entry(anchor), await entry(warded)]);
            await registry.setToken(USDG, 4n, 0n);
            // the poker buys USDG on Uniswap v3's WETH/USDG pool, then sells some into the warded pool
            await fundWeth(await poker.getAddress(), ONE);
            await poker.poke(UNI_V3_WETH_USDG, true, ONE);
            const usdg = await ethers.getContractAt("IERC20", USDG);
            const zeroForOne = (await new ethers.Contract(warded, ["function token0() view returns (address)"], ethers.provider).token0()).toLowerCase() === USDG.toLowerCase();
            await poker.poke(warded, zeroForOne, (await usdg.balanceOf(await poker.getAddress())) / (warded === RAMSES_USDG_MICRODUCK ? 4n : 400n));

            const rc = await (await vh["ward(bytes32,address)"](idAddr(warded), PAYEE, { gasLimit: 6_000_000 })).wait();
            await expectCapture(vh, rc, idAddr(anchor), [USDG, MICRODUCK]);
        }
    });

    // The launchpad fork's pairs have one pool each, so its arbitrage runs through routes: here its
    // USDG/GOO pool against USDG -> WETH -> GOO, on Uniswap v3's WETH/USDG pool and its WETH/GOO pool.
    it("wards the launchpad fork's USDG/GOO pool against a route through WETH, one hop its WETH/GOO pool", async function () {
        const { registry, vh, poker } = await fresh();
        // (USDG, GOO) sorts USDG first, so the route's first hop is (USDG, WETH), its second (WETH, GOO)
        const hop1 = idAddr(UNI_V3_WETH_USDG), hop2 = idAddr(LAUNCHPAD_WETH_GOO);
        await registry.setPools(WETH, USDG, [[hop1, 2, 100, 0]]);
        await registry.setPools(WETH, GOO, [[hop2, 2, await v3Fee(LAUNCHPAD_WETH_GOO), 0]]);
        const route = idRoute(hop1, hop2);
        await registry.setPools(USDG, GOO, [[route, ROUTE, 0, 0], [idAddr(LAUNCHPAD_USDG_GOO), 2, await v3Fee(LAUNCHPAD_USDG_GOO), 0]]);
        await registry.setConfig(route, configRoute(hop1, hop2, WETH));
        await registry.setToken(USDG, 4n, 0n);
        // the poker buys USDG on Giga's WETH/USDG pool, off the route, then sells 500 into USDG/GOO
        await fundWeth(await poker.getAddress(), ONE);
        await poker.poke(GIGA_WETH_USDG, true, ONE);
        await poker.poke(LAUNCHPAD_USDG_GOO, true, 500n * 10n ** 6n);

        const rc = await (await vh["ward(bytes32,address)"](idAddr(LAUNCHPAD_USDG_GOO), PAYEE, { gasLimit: 6_000_000 })).wait();
        await expectCapture(vh, rc, route, [USDG, GOO, WETH]);
    });

    // Abyss's pools form a triangle and trade on no other venue: its WETH/ABYSS pool against
    // WETH -> SEA -> ABYSS on its other two.
    it("wards Abyss's WETH/ABYSS pool against a route through SEA on its WETH/SEA and ABYSS/SEA pools", async function () {
        const { registry, vh, poker } = await fresh();
        // (WETH, ABYSS) sorts WETH first, so the route's first hop is (WETH, SEA), its second (SEA, ABYSS)
        const hop1 = idAddr(ABYSS_WETH_SEA), hop2 = idAddr(ABYSS_ABYSS_SEA);
        await registry.setPools(WETH, SEA, [[hop1, 2, await v3Fee(ABYSS_WETH_SEA), 0]]);
        await registry.setPools(ABYSS, SEA, [[hop2, 2, await v3Fee(ABYSS_ABYSS_SEA), 0]]);
        const route = idRoute(hop1, hop2);
        await registry.setPools(WETH, ABYSS, [[route, ROUTE, 0, 0], [idAddr(ABYSS_WETH_ABYSS), 2, await v3Fee(ABYSS_WETH_ABYSS), 0]]);
        await registry.setConfig(route, configRoute(hop1, hop2, SEA));
        // a front-run sells 2 WETH into WETH/ABYSS, about 7% of its price, past the route's fees
        await fundWeth(await poker.getAddress(), 2n * ONE);
        await poker.poke(ABYSS_WETH_ABYSS, true, 2n * ONE);

        const rc = await (await vh["ward(bytes32,address)"](idAddr(ABYSS_WETH_ABYSS), PAYEE, { gasLimit: 6_000_000 })).wait();
        await expectCapture(vh, rc, route, [WETH, ABYSS, SEA]);
    });
});
