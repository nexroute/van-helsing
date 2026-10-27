import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr, idRoute, configRoute, registerV4, ROUTE } from "./helpers/ids.js";
import { describeFork } from "./helpers/fork.js";

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const ZH = "0x0000000000000000000000000000000000000000000000000000000000000000";
// X = CAKE. Address sort is X < USDT < WBNB, so the pair (WBNB, X) has mid = USDT in the
// middle: hop2 = (USDT, WBNB) has near(USDT) == token0, exercising a walk direction that
// must come from the hop's own token sort, not from the side of the pair the hop is on.
const X = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82"; // CAKE
// Probed on the fork at BLOCK via the Pancake factories (V2 getPair / V3 getPool):
//   P1_V2  = V2 factory getPair(WBNB, CAKE); reserves 5.24M CAKE / 11493 WBNB.
//   HOP_V3 = V3 factory getPool(CAKE, USDT, 2500), the liquid tier (L ~ 7.97e24,
//            balances 2.63M CAKE / 718k USDT; the 100/500/10000 tiers are 70x+ thinner).
const P1_V2 = "0x0eD7e52944161450477ee417DE9Cd3a859b14fD0"; // CAKE/WBNB Pancake V2
const HOP_V3 = "0x7f51c8AaA6B0599aBd16674e2b17FEc7a9f674A1"; // CAKE/USDT Pancake V3 0.25%
const V3_FEE = 2500;
const BENEFICIARY = "0x00000000000000000000000000000000beC0ffEE";
const BLOCK = 103808000;
const ONE = 10n ** 18n;

// The V4 USDT/WBNB hop (aligned, deep), the same pool as univ4-fork.test.js.
const V4_HOP = [4, USDT, WBNB, 500, 10, NO_HOOKS, ZH];

describeFork("VanHelsing triangular routes (fork: V2 defended, V3 + V4 hops)", function () {
    let conn, ethers, networkHelpers, loadFixture;

    before(async function () {
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: BLOCK } } });
        ethers = conn.ethers;
        networkHelpers = conn.networkHelpers;
        loadFixture = (fn) => networkHelpers.loadFixture(fn);
    });

    async function deployFixture() {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), BENEFICIARY],
            { libraries: { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null } });

        // Route for pair (WBNB, X) via USDT: hop1 = (t0, USDT), hop2 = (USDT, t1) where
        // (t0,t1)=sorted(WBNB, X). Register each hop under its own pair.
        const v4Id = await registerV4(registry, V4_HOP); // USDT/WBNB
        const v3Id = idAddr(HOP_V3); // X/USDT

        const wLo = WBNB.toLowerCase(), xLo = X.toLowerCase();
        const [t0] = wLo < xLo ? [WBNB] : [X];
        // hop1 connects (t0, USDT); hop2 connects (USDT, t1). Assign the real pools by
        // which pair they are: X/USDT is the hop touching X; USDT/WBNB (v4) touches WBNB.
        const hop1Id = t0.toLowerCase() === wLo ? v4Id : v3Id; // (t0, USDT)
        const hop2Id = t0.toLowerCase() === wLo ? v3Id : v4Id; // (USDT, t1)

        // register hops under their real pairs
        await registry.setPools(USDT, WBNB, [[v4Id, 4, 500, 0]]);
        await registry.setPools(X, USDT, [[v3Id, 2, V3_FEE, 0]]);

        const routeId = idRoute(hop1Id, hop2Id);
        await registry.setPools(WBNB, X, [[idAddr(P1_V2), 0, 25, 0], [routeId, ROUTE, 0, 0]]);
        await registry.setConfig(routeId, configRoute(hop1Id, hop2Id, USDT));

        return { registry, vh, routeId };
    }

    // Front-run the defended V2 pair: dump WBNB straight into it and sync.
    async function skewV2Wbnb(pair, amount) {
        const p = new ethers.Contract(pair, ["function sync() external"], ethers.provider);
        const [whale] = await ethers.getSigners();
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        await networkHelpers.setBalance(whale.address, amount + ONE);
        await wbnb.connect(whale).deposit({ value: amount });
        await wbnb.connect(whale).transfer(pair, amount);
        await p.connect(whale).sync();
    }

    // WBNB-per-X price of the defended pair, scaled 1e18 (reserves oriented by token sort).
    async function pairPrice() {
        const p = new ethers.Contract(P1_V2, [
            "function getReserves() view returns (uint112, uint112, uint32)",
            "function token0() view returns (address)",
        ], ethers.provider);
        const [r0, r1] = await p.getReserves();
        const t0 = (await p.token0()).toLowerCase();
        const [rX, rW] = t0 === X.toLowerCase() ? [r0, r1] : [r1, r0];
        return (rW * ONE) / rX;
    }

    it("restores a front-run V2 pool by sinking WBNB -> USDT -> X (V4 then V3, nested lock)", async function () {
        const { vh, routeId } = await loadFixture(deployFixture);
        const wbnb = await ethers.getContractAt("IERC20", WBNB);
        const x = await ethers.getContractAt("IERC20", X);
        const usdt = await ethers.getContractAt("IERC20", USDT);

        const fair = await pairPrice();
        // The probed pair holds ~11.5k WBNB, so 300 WBNB dislocates it ~2.6%, well over
        // the 0.55% combined fees (25bp drive + 25bp V3 + 5bp V4).
        await skewV2Wbnb(P1_V2, 300n * ONE);
        const skewed = await pairPrice();
        expect(skewed).to.be.gt(fair);

        const beneW = await wbnb.balanceOf(BENEFICIARY);
        const beneX = await x.balanceOf(BENEFICIARY);
        const rc = await (await vh["ward(bytes32,address)"](idAddr(P1_V2), BENEFICIARY, { gasLimit: 12_000_000 })).wait();

        // the sink really was the route (not a direct alt)
        const captured = rc.logs
            .map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } })
            .find((e) => e && e.name === "Captured");
        expect(captured.args.anchor).to.equal(routeId);

        const gain = (await wbnb.balanceOf(BENEFICIARY)) - beneW + (await x.balanceOf(BENEFICIARY)) - beneX;
        expect(gain).to.be.gt(0n);
        const restored = await pairPrice();
        expect(restored).to.be.lt(skewed); // driven back toward fair
        // nothing stranded (ERC20s or native)
        expect(await wbnb.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await x.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await usdt.balanceOf(await vh.getAddress())).to.equal(0n);
        expect(await ethers.provider.getBalance(await vh.getAddress())).to.equal(0n);
    });
});
